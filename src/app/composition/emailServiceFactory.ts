import { createEmailRepository } from '@/infrastructure/database/inbox/emailRepositoryFactory'
import { createEntityId } from '@/models/shared/id'
import { EmailService } from '@/services/inbox/EmailService'

export async function createEmailService(): Promise<EmailService> {
  return new EmailService(await createEmailRepository(), createEntityId, Date.now)
}
