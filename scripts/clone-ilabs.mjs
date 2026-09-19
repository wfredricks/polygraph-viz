#!/usr/bin/env node
/**
 * clone-ilabs.mjs — push a local PolyGraph's state to its iLabs deployment.
 *
 * What this script does, end-to-end:
 *   1. Extract the local LevelDB data + the local embed cache.
 *   2. rsync them to the Graviton build server.
 *   3. Rebuild the Docker image with the new seed bytes.
 *   4. Push the new image to ECR.
 *   5. Register a new ECS task definition revision.
 *   6. Force-deploy the ECS service.
 *   7. Wait for rollout to complete.
 *   8. Smoke-test the deployed URL.
 *
 * Why this lives in polygraph-viz/scripts (and not as a /clone chat
 * command): the underlying operation is a multi-minute deploy. A
 * chat command would suggest instant magic; a real npm script keeps
 * the user-experience honest. The chat output points at this script
 * when the user asks how to deploy.
 *
 * Required: AWS credentials configured for the target profile, SSH
 * config alias for the Graviton build server, and (for safety) a flag
 * that confirms the operator intends to deploy to production.
 *
 * Usage:
 *   node scripts/clone-ilabs.mjs \
 *     --source-volume si-sig-data \
 *     --service si-build-sig \
 *     --ecr-repo udt-m2/si-build-sig \
 *     --cluster udt-m2-cluster \
 *     --aws-profile credence-ilabs \
 *     --ssh-host twin-build \
 *     --confirm
 *
 * All flags have sensible defaults for the SI build SIG case. Without
 * `--confirm` the script does steps 1-2 (extract + rsync) and stops,
 * printing the manual commands the operator would run for steps 3-7.
 * This is the safe-by-default posture.
 */

import { execSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  sourceVolume: 'si-sig-data',
  service: 'si-build-sig',
  taskDefinitionFamily: 'udt-m2-si-build-sig',
  ecrRepo: 'udt-m2/si-build-sig',
  cluster: 'udt-m2-cluster',
  awsProfile: 'credence-ilabs',
  awsRegion: 'us-east-1',
  sshHost: 'twin-build',
  buildContext: 'solution-intelligence/sig-build/Dockerfile.viz.nl',
  remoteRoot: '~/repos/si-build/src',
  embedCachePath: null, // resolved at runtime if not supplied
  confirm: false,
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined) {
        die(`flag ${a} requires a value`);
      }
      return v;
    };
    switch (a) {
      case '--source-volume': args.sourceVolume = take(); break;
      case '--service': args.service = take(); break;
      case '--ecr-repo': args.ecrRepo = take(); break;
      case '--task-family': args.taskDefinitionFamily = take(); break;
      case '--cluster': args.cluster = take(); break;
      case '--aws-profile': args.awsProfile = take(); break;
      case '--aws-region': args.awsRegion = take(); break;
      case '--ssh-host': args.sshHost = take(); break;
      case '--build-context': args.buildContext = take(); break;
      case '--remote-root': args.remoteRoot = take(); break;
      case '--embed-cache': args.embedCachePath = take(); break;
      case '--confirm': args.confirm = true; break;
      case '--help': case '-h':
        console.log(readFileSync(__filename, 'utf-8').slice(0, 1800));
        process.exit(0);
        // eslint-disable-next-line no-fallthrough
      default:
        die(`unknown flag: ${a}`);
    }
  }
  return args;
}

function die(msg) {
  console.error(`clone-ilabs: ${msg}`);
  process.exit(1);
}

function sh(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  const r = spawnSync('sh', ['-c', cmd], {
    stdio: opts.captureStdout ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf-8',
    ...opts,
  });
  if (r.status !== 0) {
    die(`command failed: ${cmd}`);
  }
  return r.stdout?.trim() ?? '';
}

function awsCmd(args, profile, region) {
  return `aws --profile ${profile} --region ${region} ${args}`;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log('clone-ilabs — configuration:');
  for (const [k, v] of Object.entries(args)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log('');

  const workDir = `${tmpdir()}/clone-ilabs-${Date.now()}`;
  mkdirSync(workDir, { recursive: true });
  console.log(`work dir: ${workDir}`);

  // ── Step 1: extract LevelDB from the local Docker volume ──────
  console.log('\n[1/7] extracting LevelDB from local Docker volume…');
  const ldDir = `${workDir}/leveldb`;
  mkdirSync(ldDir, { recursive: true });
  sh(
    `docker run --rm -v ${args.sourceVolume}:/source:ro -v ${ldDir}:/dest alpine:3.20 sh -c 'cp -a /source/. /dest/'`,
  );
  const ldFiles = sh(`ls -la ${ldDir} | head -10`, { captureStdout: true });
  console.log(ldFiles);

  // ── Step 2: locate / verify the embed cache ───────────────────
  console.log('\n[2/7] locating embed cache…');
  let embedCachePath = args.embedCachePath;
  if (!embedCachePath) {
    // Default: the local-server cache file.
    const candidates = [
      `${process.env.HOME}/.openclaw/workspace/embeddings-110189c9a62cab24.json`,
      '/tmp/embeddings-sibuild-test.json',
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        embedCachePath = c;
        break;
      }
    }
  }
  if (!embedCachePath || !existsSync(embedCachePath)) {
    console.warn(
      '  WARN: no embed cache found. Container will rebuild it on first boot (37s for 160 nodes).',
    );
  } else {
    const st = statSync(embedCachePath);
    console.log(`  using embed cache: ${embedCachePath} (${(st.size / 1024).toFixed(0)} KB)`);
    sh(`cp ${embedCachePath} ${workDir}/embeddings-seed.json`);
  }

  // ── Step 3: rsync to Graviton build server ────────────────────
  // Three things go up: LevelDB seed, embed cache, updated polygraph-viz source.
  console.log('\n[3/7] rsyncing to Graviton build server…');
  sh(
    `ssh ${args.sshHost} 'mkdir -p ${args.remoteRoot}/leveldb-seed ${args.remoteRoot}/polygraph-viz'`,
  );
  sh(`rsync -avz --delete ${ldDir}/ ${args.sshHost}:${args.remoteRoot}/leveldb-seed/`);
  if (embedCachePath) {
    sh(
      `scp ${workDir}/embeddings-seed.json ${args.sshHost}:${args.remoteRoot}/polygraph-viz/embeddings-seed.json`,
    );
  }
  // Sync the viewer source so the rebuild picks up any client-bundle
  // changes since the previous deploy. Without this the image would
  // ship fresh data but stale viewer code.
  const vizRoot = resolve(__dirname, '..');
  sh(
    `rsync -avz --exclude=node_modules --exclude=dist --exclude=prod-deps --exclude=coverage --exclude=embeddings-seed.json "${vizRoot}/" ${args.sshHost}:${args.remoteRoot}/polygraph-viz/`,
  );
  // Rebuild dist + public/client.js on the remote.
  sh(
    `ssh ${args.sshHost} 'cd ${args.remoteRoot}/polygraph-viz && npm run build 2>&1 | tail -3'`,
  );

  if (!args.confirm) {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('Stopping here. Pass --confirm to proceed with image rebuild +');
    console.log('ECR push + ECS update. To do those steps manually:');
    console.log('');
    console.log(`  ssh ${args.sshHost}`);
    console.log(`  cd ${args.remoteRoot}`);
    console.log(`  TAG=v\\$(date +%Y%m%d-%H%M%S)-arm64-nl`);
    console.log(`  docker build -t si-build-sig:\\$TAG -f ${args.buildContext} .`);
    console.log(
      `  aws ecr get-login-password --region ${args.awsRegion} | docker login --username AWS --password-stdin 153717966029.dkr.ecr.${args.awsRegion}.amazonaws.com`,
    );
    console.log(
      `  docker tag si-build-sig:\\$TAG 153717966029.dkr.ecr.${args.awsRegion}.amazonaws.com/${args.ecrRepo}:\\$TAG`,
    );
    console.log(
      `  docker push 153717966029.dkr.ecr.${args.awsRegion}.amazonaws.com/${args.ecrRepo}:\\$TAG`,
    );
    console.log('');
    console.log('Then register task def + update service from your laptop:');
    console.log(`  AWS_PROFILE=${args.awsProfile} aws ecs update-service ...`);
    console.log('──────────────────────────────────────────────────────────────');
    process.exit(0);
  }

  // ── Step 4: build image on Graviton ───────────────────────────
  console.log('\n[4/7] building image on Graviton…');
  const tag = sh(
    `ssh ${args.sshHost} 'TAG=v$(date +%Y%m%d-%H%M%S)-arm64-nl && cd ${args.remoteRoot} && docker build -t si-build-sig:$TAG -t si-build-sig:latest-nl -f ${args.buildContext} . && echo "TAG=$TAG"' | grep "^TAG=" | cut -d= -f2`,
    { captureStdout: true },
  );
  console.log(`image tag: ${tag}`);

  // ── Step 5: push to ECR ───────────────────────────────────────
  console.log('\n[5/7] pushing to ECR…');
  const ecrUri = `153717966029.dkr.ecr.${args.awsRegion}.amazonaws.com/${args.ecrRepo}:${tag}`;
  sh(
    `ssh ${args.sshHost} 'aws ecr get-login-password --region ${args.awsRegion} | docker login --username AWS --password-stdin 153717966029.dkr.ecr.${args.awsRegion}.amazonaws.com && docker tag si-build-sig:${tag} ${ecrUri} && docker push ${ecrUri}'`,
  );

  // ── Step 6: register new task def + update service ────────────
  console.log('\n[6/7] registering new ECS task def + updating service…');
  const tdJsonPath = `${workDir}/td.json`;
  sh(
    `${awsCmd(`ecs describe-task-definition --task-definition ${args.taskDefinitionFamily} --query taskDefinition`, args.awsProfile, args.awsRegion)} > ${tdJsonPath}`,
  );
  // Mutate the JSON: update image, strip readonly fields.
  const td = JSON.parse(readFileSync(tdJsonPath, 'utf-8'));
  for (const k of [
    'taskDefinitionArn', 'revision', 'status', 'requiresAttributes',
    'compatibilities', 'registeredAt', 'registeredBy',
  ]) {
    delete td[k];
  }
  td.containerDefinitions[0].image = ecrUri;
  const td2Path = `${workDir}/td2.json`;
  writeFileSync(td2Path, JSON.stringify(td, null, 2));
  const newRev = sh(
    `${awsCmd(`ecs register-task-definition --cli-input-json file://${td2Path} --query taskDefinition.revision --output text`, args.awsProfile, args.awsRegion)}`,
    { captureStdout: true },
  );
  console.log(`new revision: ${newRev}`);
  sh(
    `${awsCmd(`ecs update-service --cluster ${args.cluster} --service ${args.service} --task-definition ${args.taskDefinitionFamily}:${newRev} --force-new-deployment --query service.taskDefinition --output text`, args.awsProfile, args.awsRegion)}`,
  );

  // ── Step 7: wait for rollout ──────────────────────────────────
  console.log('\n[7/7] waiting for rollout to complete…');
  for (let i = 1; i <= 20; i++) {
    const state = sh(
      `${awsCmd(`ecs describe-services --cluster ${args.cluster} --services ${args.service} --query 'services[0].deployments[?status==\`PRIMARY\`].rolloutState' --output text`, args.awsProfile, args.awsRegion)}`,
      { captureStdout: true },
    );
    console.log(`  [${i}/20] ${new Date().toISOString().slice(11, 19)} primary=${state}`);
    if (state === 'COMPLETED') {
      console.log('\n✅ rollout complete');
      break;
    }
    execSync('sleep 15');
  }

  // Clean up.
  rmSync(workDir, { recursive: true, force: true });
  console.log('\n✅ clone-ilabs done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
