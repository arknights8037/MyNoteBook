export type AgentTargetKind = 'document' | 'knowledge_asset'

export interface AgentExplicitTarget {
  kind: AgentTargetKind
  id: string
  title: string
  subtitle?: string
  content?: string
  revision?: number
}

export interface AgentTargetOption {
  kind: AgentTargetKind
  id: string
  title: string
  subtitle: string
}
