/**
 * Structure IR + Style IR + Content Slot type definitions
 * V2 の中間表現。元 HTML の構造を保持する。
 */

export type LayoutLockMode = 'strict'

export type StructureKind =
  | 'section' | 'container' | 'stack' | 'inline' | 'grid' | 'columns'
  | 'text' | 'image' | 'button' | 'list' | 'list-item'
  | 'card-group' | 'card' | 'form' | 'input' | 'textarea'
  | 'divider' | 'badge' | 'icon' | 'raw'

export interface StructureNode {
  id: string
  kind: StructureKind
  children?: StructureNode[]
  textContent?: string
  htmlTag?: string
  semanticRole?: string
  attrs?: Record<string, string>
}

export interface StyleNode {
  nodeId: string
  display?: string
  flexDirection?: string
  flexWrap?: string
  justifyContent?: string
  alignItems?: string
  gridTemplateColumns?: string
  gap?: string
  padding?: string
  margin?: string
  width?: string
  height?: string
  minHeight?: string
  maxWidth?: string
  textAlign?: string
  fontSize?: string
  fontWeight?: string
  fontFamily?: string
  lineHeight?: string
  letterSpacing?: string
  textTransform?: string
  textDecoration?: string
  color?: string
  backgroundColor?: string
  backgroundImage?: string
  backgroundSize?: string
  backgroundPosition?: string
  border?: string
  borderRadius?: string
  boxShadow?: string
  opacity?: string
  objectFit?: string
  position?: string
  top?: string
  left?: string
  right?: string
  bottom?: string
  overflow?: string
  zIndex?: string
  listStyleType?: string
  whiteSpace?: string
  transition?: string
}

export interface ContentSlot {
  key: string
  kind: 'heading' | 'text' | 'buttonLabel' | 'imageAlt' | 'linkLabel' | 'listItem' | 'formLabel'
  originalValue: string
  nodeId: string
}

export interface SectionIR {
  id: string
  sourceSectionId: string
  family: string
  structure: StructureNode
  styles: StyleNode[]
  contentSlots: ContentSlot[]
  references: {
    screenshotPath: string
    sourceUrl: string
    sourceDomain: string
  }
  constraints: {
    layoutLocked: true
    preserveOrder: true
    preserveColumns: true
    preserveBackground: true
    preserveDensity: true
  }
}

export interface PageThemeOverlay {
  mode: 'strict'
  colors: Record<string, string>
  typography: {
    bodyFont: string
    headingFont: string
    headingScale: 'sm' | 'md' | 'lg'
  }
  layout: {
    containerWidth: 'xl' | '2xl' | '3xl'
    sectionSpacing: 'tight' | 'normal' | 'relaxed'
  }
  button: {
    radius: 'md' | 'lg' | 'xl' | 'full'
    style: 'solid' | 'soft' | 'outline'
  }
}
