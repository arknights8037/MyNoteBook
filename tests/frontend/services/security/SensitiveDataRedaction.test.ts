import { describe, expect, it } from 'vitest'

import { redactSensitiveText, redactSensitiveValue, safeAuditJson } from '@/services/security/SensitiveDataRedaction'

describe('SensitiveDataRedaction', () => {
  it('redacts nested credential fields without mutating ordinary tool data', () => {
    const value = redactSensitiveValue({
      title: '结果',
      headers: { Authorization: 'Bearer provider-secret', 'x-api-key': 'key-secret' },
      capabilityToken: 'delegation-secret',
      rows: [{ tokenBudget: 2048, text: '保留正文' }],
    })

    expect(value).toEqual({
      title: '结果',
      headers: { Authorization: '[REDACTED]', 'x-api-key': '[REDACTED]' },
      capabilityToken: '[REDACTED]',
      rows: [{ tokenBudget: 2048, text: '保留正文' }],
    })
  })

  it('redacts credentials embedded in provider errors and free-form logs', () => {
    const redacted = redactSensitiveText(
      '401 {"api_key":"sk-provider-secret","authorization":"Bearer abc.def.secret"} https://user:pass@example.com',
    )

    expect(redacted).not.toContain('sk-provider-secret')
    expect(redacted).not.toContain('abc.def.secret')
    expect(redacted).not.toContain(':pass@')
    expect(redacted).toContain('[REDACTED]')
  })

  it('serializes circular tool results safely', () => {
    const value: Record<string, unknown> = { apiKey: 'secret' }
    value.self = value
    expect(safeAuditJson(value)).toBe('{"apiKey":"[REDACTED]","self":"[CIRCULAR]"}')
  })

  it('keeps oversized audit payloads as valid versioned JSON', () => {
    const parsed = JSON.parse(safeAuditJson({ content: 'x'.repeat(1_000) }, 240))

    expect(parsed).toMatchObject({ version: 1, truncated: true })
    expect(parsed.originalChars).toBeGreaterThan(1_000)
    expect(parsed.preview).toEqual(expect.any(String))
  })
})
