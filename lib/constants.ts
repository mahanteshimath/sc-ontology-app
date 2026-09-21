/** App title — displayed in the nav header and browser tab */
export const APP_TITLE = "Supply Chain Ontology"

/**
 * Path to the favicon in /public.
 *
 * Favicon only. The header draws the mark from components/brand-mark.tsx instead, because an SVG
 * loaded through `next/image` becomes an isolated document and cannot inherit the page's theme
 * colour — which left the logo rendering black in dark mode.
 */
export const LOGO_SRC = "/icon.svg"

/** Team name, shown in the header subtitle */
export const TEAM_NAME = "3M-ONTOLOGIST"

/** Fully-qualified names of the governed objects this app reads. */
export const DB = "SUPPLY_CHAIN"
export const ONTOLOGY_VIEW = "SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360"
export const AGENT_FQN = "SNOWFLAKE_INTELLIGENCE.AGENTS.SC_ONTOLOGIST_AGENT"

/** Model used for governed metric resolution in the conversational layer. */
export const RESOLVER_MODEL = "claude-sonnet-4-5"
