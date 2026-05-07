/**
 * Embedded Example — PolyGraph Viz as a React component.
 *
 * Usage in any React app (Next.js, Vite, CRA):
 *
 *   import { PolyGraphViz } from 'polygraph-viz';
 *   <PolyGraphViz config={{ demo: true }} />
 */

import React from 'react';
// import { PolyGraphViz } from 'polygraph-viz';

export default function App() {
  return (
    <div style={{ width: '100%', height: '100vh' }}>
      <h1>Embedded PolyGraph Viz</h1>
      {/* <PolyGraphViz
        config={{ demo: true }}
        theme={{
          background: '#1a1a2e',
          foreground: '#eee',
          accent: '#e94560',
          fontSize: 12,
          mode: 'dark',
        }}
      /> */}
      <p>Uncomment the PolyGraphViz component after installing polygraph-viz.</p>
    </div>
  );
}
