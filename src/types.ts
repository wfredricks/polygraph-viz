/**
 * PolyGraph Visualizer Types
 *
 * Why: Shared types between the server, API, and renderer.
 */

/** Graph export format — what the visualizer consumes */
export interface GraphExport {
  nodes: VizNode[];
  edges: VizEdge[];
  metadata: {
    source: string;
    nodeCount: number;
    edgeCount: number;
    exportedAt: string;
  };
}

/** Node as rendered in the visualizer */
export interface VizNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
  /** Computed by renderer */
  x?: number;
  y?: number;
  degree?: number;
  color?: string;
}

/** Edge as rendered in the visualizer */
export interface VizEdge {
  id: string;
  type: string;
  fromId: string;
  toId: string;
  properties: Record<string, unknown>;
}

/** Visualizer configuration */
export interface VizConfig {
  /** LevelDB path (local mode) */
  path?: string;
  /** Remote API URL */
  url?: string;
  /** Load demo data */
  demo?: boolean;
  /** HTTP port for the visualizer server */
  port?: number;
  /** Enable write mode */
  write?: boolean;
  /** Auto-open browser */
  open?: boolean;
}

/** Graph statistics */
export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  labelDistribution: Record<string, number>;
  relationshipDistribution: Record<string, number>;
  density: number;
  components: number;
}

/** Search result */
export interface SearchResult {
  nodeId: string;
  matchedProperty: string;
  matchedValue: string;
  score: number;
}

/** Label color mapping */
export interface ColorScheme {
  [label: string]: string;
}

/** Default color scheme — distinct colors for common labels */
export const DEFAULT_COLORS: ColorScheme = {
  Twin: '#4A90D9',
  Identity: '#7B68EE',
  Principle: '#9B59B6',
  Narrative: '#8E44AD',
  Occupation: '#E67E22',
  Task: '#F1C40F',
  Domain: '#2ECC71',
  ArtifactSpec: '#1ABC9C',
  Document: '#27AE60',
  Role: '#E74C3C',
  Constellation: '#3498DB',
  TeamMember: '#D35400',
  Message: '#95A5A6',
  Session: '#BDC3C7',
  User: '#2980B9',
  Insight: '#8E44AD',
  Pattern: '#16A085',
  Habit: '#F39C12',
  Module: '#34495E',
  Function: '#7F8C8D',
  Class: '#C0392B',
  Interface: '#2C3E50',
  Requirement: '#E74C3C',
  Feature: '#3498DB',
  Decision: '#9B59B6',
  NISTControl: '#E74C3C',
  POSAPattern: '#F39C12',
  EIPPattern: '#1ABC9C',
  WAFPractice: '#3498DB',
};
