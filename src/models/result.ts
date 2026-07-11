export type AppResult<T> = { ok: true; value: T } | { ok: false; error: AppError }

export type AppErrorCode =
  | 'database-unavailable'
  | 'not-found'
  | 'revision-conflict'
  | 'validation-error'
  | 'unknown'

export interface AppError {
  code: AppErrorCode
  message: string
  cause?: unknown
}

export function ok<T>(value: T): AppResult<T> {
  return { ok: true, value }
}

export function err<T = never>(error: AppError): AppResult<T> {
  return { ok: false, error }
}

export function normalizeError(error: unknown, fallbackMessage: string): AppError {
  if (error instanceof Error) {
    return {
      code: 'unknown',
      message: error.message || fallbackMessage,
      cause: error,
    }
  }

  if (typeof error === 'string' && error.trim()) {
    return { code: 'unknown', message: error.trim(), cause: error }
  }

  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: unknown }).message ?? '').trim()
    if (message) return { code: 'unknown', message, cause: error }
  }

  return {
    code: 'unknown',
    message: fallbackMessage,
    cause: error,
  }
}
