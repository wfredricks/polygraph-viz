# PolyGraph Visualizer — Manual Test Script

**Date:** 2026-05-07
**Tester:** _______________

---

## Test 1: Demo Mode Starts

```bash
cd artifacts/polygraph-viz
npm install
npx tsx src/cli.ts --demo --port 4444
```

**Expected:** Server starts, prints node/edge count, shows URL.
**Result:** [ ] PASS / [ ] FAIL

---

## Test 2: Browser Renders Graph

Open http://localhost:4444

**Expected:**
- Dark background (#1a1a2e)
- Force-directed graph with 15 nodes (BillDT twin graph)
- Nodes colored by label (blue Twin, green Document, etc.)
- Node labels visible (BillDT, resume.pdf, solutions-architect, etc.)
- Color legend in top-left
- Stats panel on right (15 nodes, 14 edges)

**Result:** [ ] PASS / [ ] FAIL

---

## Test 3: Node Inspection

Click on the "BillDT" node.

**Expected:** Side panel shows:
- Name: BillDT
- Labels: Twin
- Properties table (name, type, status)
- Outgoing relationships (HAS_IDENTITY, HAS_OCCUPATION, PERFORMS_ROLE, etc.)

**Result:** [ ] PASS / [ ] FAIL

---

## Test 4: Search

Type "resume" in the search box.

**Expected:** Only nodes matching "resume" remain visible.
**Result:** [ ] PASS / [ ] FAIL

---

## Test 5: API Endpoints

```bash
curl http://localhost:4444/api/graph | jq '.metadata'
curl http://localhost:4444/api/stats | jq '.nodeCount, .edgeCount'
curl "http://localhost:4444/api/search?q=architect" | jq length
```

**Expected:**
- /api/graph returns full graph with metadata
- /api/stats returns nodeCount: 15, edgeCount: 14
- /api/search returns matching nodes

**Result:** [ ] PASS / [ ] FAIL

---

## Test 6: Local PolyGraph Path

```bash
# Create a test graph first
cd artifacts/twin
npx tsx -e "
const { createPolyGraph } = require('./src/foundation/graph/polygraph-impl.ts');
const { seedIdentity } = require('./src/organism/core/identity-seed.ts');
const { loadAndSeedBirthright } = require('./src/organism/core/birthright-loader.ts');
const { loadAndSeedOccupation } = require('./src/organism/core/occupation-loader.ts');
(async () => {
  const pg = createPolyGraph({ storage: 'persistent', path: '/tmp/viz-test-graph' });
  await pg.open();
  await seedIdentity({ twinId: 'bill-personal', name: 'BillDT', type: 'personal', constellationId: 'twin-standard' }, pg.mutator);
  await loadAndSeedBirthright('bill-personal', './birthright', pg.mutator);
  await loadAndSeedOccupation('bill-personal', 'personal', './occupation', pg.mutator, { TWIN_ID: 'bill-personal' });
  console.log('Graph created:', (await pg.reader.health()).nodeCount, 'nodes');
  await pg.close();
})();
"

# Then visualize it
cd artifacts/polygraph-viz
npx tsx src/cli.ts --path /tmp/viz-test-graph --port 4445
```

**Expected:** Visualizer shows the real twin graph from LevelDB.
**Result:** [ ] PASS / [ ] FAIL

---

## Summary

| Test | Description | Result |
|------|-------------|--------|
| 1 | Demo mode starts | [ ] PASS / [ ] FAIL |
| 2 | Browser renders graph | [ ] PASS / [ ] FAIL |
| 3 | Node inspection | [ ] PASS / [ ] FAIL |
| 4 | Search | [ ] PASS / [ ] FAIL |
| 5 | API endpoints | [ ] PASS / [ ] FAIL |
| 6 | Local PolyGraph path | [ ] PASS / [ ] FAIL |

**Sign-off:** [ ] APPROVED / [ ] NEEDS WORK
**Signed:** _______________ **Date:** _______________

---

## What Ships

- `npx polygraph-viz --demo` — instant visual, zero config
- `npx polygraph-viz --path ./data` — visualize any PolyGraph
- Dark theme, force-directed layout, search, node inspection
- API: /api/graph, /api/stats, /api/search
- Examples: standalone, embedded (React), iframe
- Theming: dark/light, custom colors, font sizes
- Layout modes: force-directed, hierarchical, radial, grid, concentric
