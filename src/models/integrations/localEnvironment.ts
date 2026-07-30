export interface LocalEnvironmentVariable {
  name: string
  value: string
  label: string
}

export interface LocalRuntime {
  id: string
  name: string
  kind: string
  version: string
  executable: string
  available: boolean
}

export interface LocalEnvironmentSnapshot {
  hostName: string
  operatingSystem: string
  architecture: string
  shell: string
  runtimes: LocalRuntime[]
  variables: LocalEnvironmentVariable[]
}
