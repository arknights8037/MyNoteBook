import { describe, expect, it } from 'vitest'

import {
  JsonCodecError,
  parseJsonArray,
  parseJsonObject,
  parseJsonOrNull,
  parseJsonStrict,
  parseStringArray,
  parseVersionedJson,
} from '@/repositories/shared/jsonCodec'

describe('jsonCodec', () => {
  it('uses explicit tolerant fallbacks for optional JSON fields', () => {
    expect(parseJsonOrNull('{broken')).toBeNull()
    expect(parseJsonObject('{broken')).toEqual({})
    expect(parseJsonArray('{broken')).toEqual([])
    expect(parseStringArray('["a", 1, "b"]')).toEqual(['a', 'b'])
  })

  it('rejects malformed required JSON with a stable field-aware error', () => {
    expect(() => parseJsonStrict('{broken', '思维导图数据')).toThrow(JsonCodecError)
    expect(() => parseJsonStrict('{broken', '思维导图数据')).toThrow('无法解析 思维导图数据 JSON。')
  })

  it('only accepts the requested versioned envelope', () => {
    expect(parseVersionedJson('{"version":1,"value":true}')).toEqual({
      version: 1,
      value: true,
    })
    expect(parseVersionedJson('{"version":2}')).toBeNull()
  })
})
