export const MAX_IMAGE_FILE_SIZE = 15 * 1024 * 1024

export function validateImageFile(file: File): string | null {
  if (!file.type.startsWith('image/')) {
    return '请选择图片文件'
  }

  if (file.size > MAX_IMAGE_FILE_SIZE) {
    return '图片不能超过 15 MB'
  }

  return null
}
