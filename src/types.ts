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
  /** Theme configuration */
  theme?: ThemeConfig;
  /** Default layout mode */
  layout?: LayoutMode;
}

/** Theme configuration — customizable colors and fonts */
export interface ThemeConfig {
  /** Color mode */
  mode: 'dark' | 'light';
  /** Background color (hex) */
  background?: string;
  /** Foreground/text color (hex) */
  foreground?: string;
  /** Accent color for highlights and UI elements (hex) */
  accent?: string;
  /** Panel/sidebar background */
  panelBackground?: string;
  /** Border color */
  border?: string;
  /** Base font size in pixels */
  fontSize?: number;
  /** Node label font size */
  nodeFontSize?: number;
  /** Override label colors */
  labelColors?: ColorScheme;
}

/** Pre-built themes */
export const DARK_THEME: ThemeConfig = {
  mode: 'dark',
  background: '#1a1a2e',
  foreground: '#eeeeee',
  accent: '#e94560',
  panelBackground: '#16213e',
  border: '#0f3460',
  fontSize: 12,
  nodeFontSize: 9,
};

export const LIGHT_THEME: ThemeConfig = {
  mode: 'light',
  background: '#ffffff',
  foreground: '#333333',
  accent: '#2563eb',
  panelBackground: '#f8fafc',
  border: '#e2e8f0',
  fontSize: 12,
  nodeFontSize: 9,
};

/** Layout modes for graph rendering */
export type LayoutMode =
  | 'force-directed'     // Default: spring physics
  | 'hierarchical'       // Top-down tree layout
  | 'radial'             // Radial from center node
  | 'grid'               // Grid layout for flat collections
  | 'concentric';        // Concentric circles by label

/** Layout mode metadata */
export const LAYOUT_MODES: Record<LayoutMode, { name: string; description: string; icon: string }> = {
  'force-directed': { name: 'Force Directed', description: 'Physics-based spring layout', icon: '🕸️' },
  'hierarchical': { name: 'Hierarchical', description: 'Top-down tree layout', icon: '🌳' },
  'radial': { name: 'Radial', description: 'Radial from selected center', icon: '🎯' },
  'grid': { name: 'Grid', description: 'Grid layout for collections', icon: '▦' },
  'concentric': { name: 'Concentric', description: 'Rings grouped by label', icon: '◎' },
};

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
