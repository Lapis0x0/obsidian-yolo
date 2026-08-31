export type RuntimeComponentId =
  | 'tokenizer'
  | 'pdf-engine'
  | 'bash-engine'
  | 'embedding-engine'

export type RuntimeComponentDefinition<TApi = unknown> = Readonly<{
  id: RuntimeComponentId
  create(): TApi | Promise<TApi>
}>

declare global {
  var __yolo_register_runtime_component__: (
    definition: RuntimeComponentDefinition,
  ) => void
}

export {}
