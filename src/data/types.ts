// 数据结构定义：与数据管线输出 schema 一一对应（见规格书第二节）。

export type NodeType =
  | 'definition'
  | 'lemma'
  | 'proposition'
  | 'theorem'
  | 'remark'
  | 'example'
  | 'exercise'
  | 'situation'
  | 'section'

export interface MetaJson {
  commit: string
  commitShort: string
  parsedAt: string
  nodeCount: number
  edgeCount: number
  typeCounts: Record<string, number>
  maxHeight: number
  maxHeightTag: string
  chapterCount: number
  brokenCycles: unknown[]
  layoutSeed: number
}

export interface GraphChapter {
  id: number
  slug: string
  title: string
  nodeCount: number
  center: [number, number, number]
  radius: number
}

export interface GraphNode {
  tag: string
  label?: string
  type: NodeType
  chapter: string
  section: string
  height: number
  indegree: number
  pos: [number, number, number]
}

export interface GraphJson {
  chapters: GraphChapter[]
  nodes: GraphNode[]
  edges: [number, number][]
}

export interface ContentEntry {
  statement: string
  proof: string | null
  section: string
}

export interface ChapterContent {
  chapter: string
  entries: Record<string, ContentEntry>
}

export type QualityLevel = 'standard' | 'high' | 'cinematic'

/** 着色模式索引：0 height / 1 chapter / 2 type / 3 degree（与参数 COLOR MODE 0–3 对齐） */
export const COLOR_MODES = ['height', 'chapter', 'type', 'degree'] as const
export type ColorModeName = (typeof COLOR_MODES)[number]

/** 节点类型固定配色（规格书第三节，不得更改） */
export const TYPE_COLORS: Record<NodeType, string> = {
  definition: '#4fc3f7',
  lemma: '#7ee0a3',
  proposition: '#9d97f2',
  theorem: '#f2b84b',
  remark: '#6b8cae',
  example: '#62d2c8',
  exercise: '#c58cc8',
  situation: '#8f9bb0',
  section: '#eaf6ff',
}

export const NODE_TYPES = Object.keys(TYPE_COLORS) as NodeType[]
