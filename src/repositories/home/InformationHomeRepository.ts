import type {
  InformationHome,
  InformationHomePayload,
  InformationHomeSummary,
} from '@/models/home/informationHome'
import type { AppResult } from '@/models/shared/result'

export interface InformationHomeRepository {
  get(): Promise<AppResult<InformationHome>>
  create(home: InformationHome): Promise<AppResult<InformationHome>>
  updatePayload(
    payload: InformationHomePayload,
    expectedVersion: number,
    updatedAt: number,
  ): Promise<AppResult<InformationHome>>
  updateSummarySettings(
    enabled: boolean,
    intervalMinutes: number,
    updatedAt: number,
  ): Promise<AppResult<InformationHome>>
  listSummaries(limit?: number): Promise<AppResult<InformationHomeSummary[]>>
  createSummary(summary: InformationHomeSummary): Promise<AppResult<InformationHomeSummary>>
}
