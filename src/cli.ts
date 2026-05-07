#!/usr/bin/env node
/**
 * PolyGraph Visualizer CLI
 *
 * Usage:
 *   npx polygraph-viz --path ./my-graph-data
 *   npx polygraph-viz --url http://localhost:3000/api/graph
 *   npx polygraph-viz --demo
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { connectGraph, exportGraph, buildDemoGraph, computeStats, searchNodes, filterByLabels } from './graph-api.js';
import { DEFAULT_COLORS } from './types.js';
import type { VizConfig, GraphExport } from './types.js';

// ── Parse CLI args ───────────────────────────────────────────────

function parseArgs(): VizConfig {
  const args = process.argv.slice(2);
  const config: VizConfig = { port: 4444 };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--path': config.path = args[++i]; break;
      case '--url': config.url = args[++i]; break;
      case '--demo': config.demo = true; break;
      case '--port': config.port = parseInt(args[++i]); break;
      case '--write': config.write = true; break;
      case '--open': config.open = true; break;
    }
  }

  if (!config.path && !config.url && !config.demo) {
    config.demo = true; // Default to demo mode
  }

  return config;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const config = parseArgs();
  const app = new Hono();

  let graphData: GraphExport;

  if (config.demo) {
    console.log('🎨 PolyGraph Visualizer — Demo Mode');
    graphData = buildDemoGraph();
  } else if (config.path) {
    console.log(`🎨 PolyGraph Visualizer — Local: ${config.path}`);
    const graph = await connectGraph(config.path);
    graphData = await exportGraph(graph);
  } else if (config.url) {
    console.log(`🎨 PolyGraph Visualizer — Remote: ${config.url}`);
    const response = await fetch(config.url);
    graphData = await response.json() as GraphExport;
  } else {
    graphData = buildDemoGraph();
  }

  // API routes
  app.get('/api/graph', (c) => c.json(graphData));
  app.get('/api/stats', (c) => c.json(computeStats(graphData)));
  app.get('/api/search', (c) => {
    const q = c.req.query('q') || '';
    return c.json(searchNodes(graphData, q));
  });
  app.get('/api/filter/labels', (c) => {
    const labels = (c.req.query('labels') || '').split(',').filter(Boolean);
    return c.json(filterByLabels(graphData, labels));
  });

  // Serve the HTML visualizer
  app.get('/', (c) => {
    return c.html(getIndexHtml(graphData));
  });

  const port = config.port || 4444;
  serve({ fetch: app.fetch, port }, () => {
    console.log(`\n  🕸️  Graph: ${graphData.metadata.nodeCount} nodes, ${graphData.metadata.edgeCount} edges`);
    console.log(`  🌐  Open: http://localhost:${port}\n`);
  });

  if (config.open) {
    const { exec } = await import('child_process');
    exec(`open http://localhost:${port}`);
  }
}

function getIndexHtml(data: GraphExport): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>PolyGraph Visualizer</title>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #eee; }
    #app { display: flex; height: 100vh; }
    #graph { flex: 1; }
    #panel { width: 320px; background: #16213e; padding: 16px; overflow-y: auto; border-left: 1px solid #0f3460; }
    #panel h2 { font-size: 14px; color: #e94560; margin-bottom: 8px; }
    #panel .stats { font-size: 12px; color: #aaa; }
    #panel .stat-row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #0f3460; }
    #search { width: 100%; padding: 8px; margin-bottom: 12px; background: #0f3460; border: 1px solid #e94560; color: #eee; border-radius: 4px; }
    #search:focus { outline: none; border-color: #fff; }
    svg { width: 100%; height: 100%; }
    .node circle { stroke: #fff; stroke-width: 1.5; cursor: pointer; }
    .node text { font-size: 10px; fill: #ccc; pointer-events: none; }
    .edge line { stroke: #444; stroke-width: 1; }
    .edge text { font-size: 8px; fill: #666; }
    #legend { position: absolute; top: 12px; left: 12px; background: rgba(22,33,62,0.9); padding: 8px 12px; border-radius: 6px; font-size: 11px; }
    .legend-item { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
    .legend-dot { width: 10px; height: 10px; border-radius: 50%; }
    #title { position: absolute; top: 12px; right: 340px; font-size: 16px; color: #e94560; font-weight: bold; }
    #node-detail { margin-top: 12px; }
    #node-detail h3 { color: #e94560; font-size: 13px; margin: 8px 0 4px; }
    #node-detail table { width: 100%; font-size: 11px; }
    #node-detail td { padding: 2px 4px; border-bottom: 1px solid #0f3460; word-break: break-all; }
    #node-detail td:first-child { color: #e94560; width: 35%; }
  </style>
</head>
<body>
  <div id="app">
    <div id="graph" style="position: relative;">
      <div id="title">PolyGraph Visualizer</div>
      <div id="legend"></div>
      <svg id="svg"></svg>
    </div>
    <div id="panel">
      <h2>🕸️ PolyGraph</h2>
      <input id="search" type="text" placeholder="Search nodes..." />
      <div class="stats" id="stats"></div>
      <div id="node-detail"></div>
    </div>
  </div>
  <script>
    // Graph data injected from server
    const graphData = ${JSON.stringify(data)};
    
    // Simple force-directed layout (no D3 dependency for MVP)
    const nodes = graphData.nodes.map(n => ({
      ...n,
      x: Math.random() * 800 + 100,
      y: Math.random() * 600 + 100,
      vx: 0, vy: 0,
    }));
    const edges = graphData.edges;
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    
    // Color scheme
    const colors = ${JSON.stringify(DEFAULT_COLORS)};
    const getColor = (labels) => {
      for (const l of labels) if (colors[l]) return colors[l];
      return '#7F8C8D';
    };
    
    // Compute degrees
    const degrees = new Map();
    edges.forEach(e => {
      degrees.set(e.fromId, (degrees.get(e.fromId) || 0) + 1);
      degrees.set(e.toId, (degrees.get(e.toId) || 0) + 1);
    });
    
    // Stats
    const labelDist = {};
    nodes.forEach(n => n.labels.forEach(l => labelDist[l] = (labelDist[l]||0) + 1));
    document.getElementById('stats').innerHTML = 
      '<div class="stat-row"><span>Nodes</span><span>' + nodes.length + '</span></div>' +
      '<div class="stat-row"><span>Edges</span><span>' + edges.length + '</span></div>' +
      Object.entries(labelDist).sort((a,b) => b[1]-a[1]).map(([l,c]) =>
        '<div class="stat-row"><span>' + l + '</span><span>' + c + '</span></div>'
      ).join('');
    
    // Legend
    const usedLabels = [...new Set(nodes.flatMap(n => n.labels))];
    document.getElementById('legend').innerHTML = usedLabels.map(l =>
      '<div class="legend-item"><div class="legend-dot" style="background:' + (colors[l]||'#7F8C8D') + '"></div>' + l + '</div>'
    ).join('');
    
    // SVG rendering
    const svg = document.getElementById('svg');
    const ns = 'http://www.w3.org/2000/svg';
    
    // Force simulation (simple spring model)
    function simulate() {
      for (let iter = 0; iter < 100; iter++) {
        // Repulsion between all nodes
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const dx = nodes[j].x - nodes[i].x;
            const dy = nodes[j].y - nodes[i].y;
            const d = Math.sqrt(dx*dx + dy*dy) || 1;
            const force = 5000 / (d * d);
            const fx = (dx / d) * force;
            const fy = (dy / d) * force;
            nodes[i].vx -= fx; nodes[i].vy -= fy;
            nodes[j].vx += fx; nodes[j].vy += fy;
          }
        }
        // Attraction along edges
        edges.forEach(e => {
          const a = nodeMap.get(e.fromId);
          const b = nodeMap.get(e.toId);
          if (!a || !b) return;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.sqrt(dx*dx + dy*dy) || 1;
          const force = (d - 120) * 0.01;
          const fx = (dx / d) * force;
          const fy = (dy / d) * force;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        });
        // Center gravity
        const cx = 500, cy = 400;
        nodes.forEach(n => {
          n.vx += (cx - n.x) * 0.001;
          n.vy += (cy - n.y) * 0.001;
          n.x += n.vx * 0.5;
          n.y += n.vy * 0.5;
          n.vx *= 0.9; n.vy *= 0.9;
        });
      }
    }
    simulate();
    
    function render() {
      svg.innerHTML = '';
      // Edges
      edges.forEach(e => {
        const a = nodeMap.get(e.fromId);
        const b = nodeMap.get(e.toId);
        if (!a || !b) return;
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
        line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
        line.setAttribute('stroke', '#444'); line.setAttribute('stroke-width', '1');
        svg.appendChild(line);
      });
      // Nodes
      nodes.forEach(n => {
        const g = document.createElementNS(ns, 'g');
        g.setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')');
        g.style.cursor = 'pointer';
        g.onclick = () => showNodeDetail(n);
        
        const r = 6 + (degrees.get(n.id) || 0) * 2;
        const circle = document.createElementNS(ns, 'circle');
        circle.setAttribute('r', r);
        circle.setAttribute('fill', getColor(n.labels));
        circle.setAttribute('stroke', '#fff');
        circle.setAttribute('stroke-width', '1');
        g.appendChild(circle);
        
        const text = document.createElementNS(ns, 'text');
        text.setAttribute('dy', r + 12);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', '#aaa');
        text.setAttribute('font-size', '9');
        text.textContent = n.properties.name || n.properties.title || n.labels[0] || n.id.substring(0,8);
        g.appendChild(text);
        
        svg.appendChild(g);
      });
    }
    render();
    
    function showNodeDetail(n) {
      const props = Object.entries(n.properties).map(([k,v]) =>
        '<tr><td>' + k + '</td><td>' + String(v).substring(0,100) + '</td></tr>'
      ).join('');
      const inEdges = edges.filter(e => e.toId === n.id);
      const outEdges = edges.filter(e => e.fromId === n.id);
      document.getElementById('node-detail').innerHTML =
        '<h3>' + (n.properties.name || n.id) + '</h3>' +
        '<p style="color:#888;font-size:11px">' + n.labels.join(', ') + '</p>' +
        '<h3>Properties</h3><table>' + props + '</table>' +
        '<h3>Incoming (' + inEdges.length + ')</h3>' +
        inEdges.map(e => '<div style="font-size:11px;color:#aaa">←[' + e.type + '] ' + e.fromId.substring(0,12) + '</div>').join('') +
        '<h3>Outgoing (' + outEdges.length + ')</h3>' +
        outEdges.map(e => '<div style="font-size:11px;color:#aaa">→[' + e.type + '] ' + e.toId.substring(0,12) + '</div>').join('');
    }
    
    // Search
    document.getElementById('search').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      nodes.forEach(n => {
        const match = !q || Object.values(n.properties).some(v => String(v).toLowerCase().includes(q)) || n.labels.some(l => l.toLowerCase().includes(q));
        n._hidden = !match;
      });
      render();
    };
  </script>
</body>
</html>`;
}

main().catch(console.error);
