import { describe, expect, it } from 'vitest'

import { MAX_IMAGE_FILE_SIZE, validateImageFile } from '@/editor/io/imageFile'

describe('imageFile', () => {
  it('rejects non-image and oversized files', () => {
    expect(validateImageFile(new File(['notes'], 'notes.txt', { type: 'text/plain' }))).toBe(
      '请选择图片文件',
    )
    expect(
      validateImageFile(
        new File([new Uint8Array(MAX_IMAGE_FILE_SIZE + 1)], 'huge.png', {
          type: 'image/png',
        }),
      ),
    ).toBe('图片不能超过 15 MB')
  })
})
