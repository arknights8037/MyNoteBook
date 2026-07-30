export interface LocalEnvironmentVariable {
  name: string
  value: string
  category: string
  isPathList: boolean
}

export interface LocalEnvironmentSnapshot {
  hostName: string
  operatingSystem: string
  architecture: string
  shell: string
  variables: LocalEnvironmentVariable[]
}
