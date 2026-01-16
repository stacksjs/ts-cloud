/**
 * Common AWS Types
 */

export interface Tag {
  Key: string
  Value: string
}

export type Tags = Tag[]

export interface ResourceBase {
  Type: string
  Properties: Record<string, any>
  DependsOn?: string | string[]
  Condition?: string
  DeletionPolicy?: 'Delete' | 'Retain' | 'Snapshot'
  UpdateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot'
  Metadata?: Record<string, any>
}
