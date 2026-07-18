<script setup lang="ts">
import {
  BookOpen,
  Brain,
  Check,
  CircleCheck,
  CircleHelp,
  CircleX,
  FileText,
  GitFork,
  Lightbulb,
  ListChecks,
  Pencil,
  Quote,
  SearchCheck,
  X,
} from '@lucide/vue'
import { ref } from 'vue'

import type {
  LearningUnderstandingState,
  ResearchCandidateRef,
  ResearchItemKind,
  ResearchResult,
  ReviewIssue,
  ReviewIssueType,
} from '@/models/cognitive'
import type { AiChatPanelMessage } from './aiChatPanelTypes'

defineProps<{
  message: AiChatPanelMessage
  isRunning: boolean
}>()

const emit = defineEmits<{
  'open-source': [documentId: string, blockId?: string]
  'research-candidate-action': [
    input: {
      messageId: string
      itemId: string
      candidateId: string
      expectedVersion: number
      action: 'keep' | 'approve' | 'reject'
      title?: string
      content?: string
    },
  ]
  'resolve-review-issue': [input: { messageId: string; issue: ReviewIssue }]
}>()

const editingResearchCandidateId = ref<string | null>(null)
const researchCandidateTitle = ref('')
const researchCandidateContent = ref('')

const researchKindLabels: Record<ResearchItemKind, string> = {
  claim: '结论',
  evidence: '证据',
  assumption: '假设',
  inference: '推断',
  limitation: '限制',
  conflict: '冲突',
  question: '问题',
}
const reviewIssueLabels: Record<ReviewIssueType, string> = {
  unsupported_claim: '结论缺少支持',
  missing_source: '缺少来源',
  logical_gap: '逻辑缺口',
  conflict: '内容冲突',
  undefined_term: '术语未定义',
  missing_scope_or_assumption: '范围或假设缺失',
  outdated_information: '信息已过期',
  evidence_mismatch: '证据不匹配',
  ambiguity: '表达歧义',
}
const learningStateLabels: Record<LearningUnderstandingState, string> = {
  not_assessed: '等待首次尝试',
  partial: '部分理解',
  misconception: '存在误解',
  demonstrated: '已展示理解',
  needs_review: '需要复习',
}

function researchKindLabel(kind: ResearchItemKind): string {
  return researchKindLabels[kind]
}

function researchRelationLabel(
  relationType: ResearchResult['relations'][number]['relationType'],
): string {
  if (relationType === 'supports') return '支持'
  if (relationType === 'conflicts_with') return '冲突'
  if (relationType === 'derives_from') return '推导自'
  return '关联'
}

function reviewIssueLabel(issueType: ReviewIssueType): string {
  return reviewIssueLabels[issueType]
}

function reviewSeverityLabel(severity: ReviewIssue['severity']): string {
  if (severity === 'error') return '高'
  if (severity === 'warning') return '中'
  return '低'
}

function learningStateLabel(state: LearningUnderstandingState): string {
  return learningStateLabels[state]
}

function researchValidationLabel(
  status: ResearchResult['items'][number]['validationStatus'],
): string {
  if (status === 'verified') return '已定位来源'
  if (status === 'warning') return '需要复核'
  return '未验证'
}

function getResearchCandidate(
  message: AiChatPanelMessage,
  itemId: string,
): ResearchCandidateRef | null {
  return message.researchCandidates?.find((candidate) => candidate.itemId === itemId) ?? null
}

function researchCandidateDecisionLabel(candidate: ResearchCandidateRef): string {
  if (candidate.sourceState === 'stale') return '需要重新验证'
  if (candidate.decision === 'approved') return '已接受'
  if (candidate.decision === 'rejected') return '已拒绝'
  if (candidate.decision === 'kept') return '已保留'
  return '等待确认'
}

function startResearchCandidateEdit(candidate: ResearchCandidateRef): void {
  editingResearchCandidateId.value = candidate.candidateId
  researchCandidateTitle.value = candidate.title
  researchCandidateContent.value = candidate.content
}

function cancelResearchCandidateEdit(): void {
  editingResearchCandidateId.value = null
  researchCandidateTitle.value = ''
  researchCandidateContent.value = ''
}

function decideResearchCandidate(
  message: AiChatPanelMessage,
  candidate: ResearchCandidateRef,
  action: 'keep' | 'approve' | 'reject',
  edited = false,
): void {
  emit('research-candidate-action', {
    messageId: message.id,
    itemId: candidate.itemId,
    candidateId: candidate.candidateId,
    expectedVersion: candidate.version,
    action,
    ...(edited
      ? { title: researchCandidateTitle.value, content: researchCandidateContent.value }
      : {}),
  })
  cancelResearchCandidateEdit()
}
</script>

<template>
  <div v-if="message.researchResult" class="ai-research-result" aria-label="结构化调研结果">
    <header class="ai-research-result__header">
      <span><SearchCheck :size="15" /><b>/research</b> 调研结果</span>
      <small>{{ message.researchResult.items.length }} 项发现</small>
    </header>
    <section class="ai-structured-result__summary">
      <span>结论摘要</span>
      <p>{{ message.researchResult.summary }}</p>
    </section>
    <ol class="ai-research-result__items">
      <li
        v-for="(item, itemIndex) in message.researchResult.items"
        :key="`${message.id}:${item.id}`"
        :class="`is-${item.validationStatus}`"
      >
        <div class="ai-research-result__item-head">
          <span class="ai-structured-result__index">{{ itemIndex + 1 }}</span>
          <span class="ai-structured-result__tag">{{ researchKindLabel(item.kind) }}</span>
          <strong>{{ getResearchCandidate(message, item.id)?.title ?? item.title }}</strong>
          <em :class="`is-${item.validationStatus}`">{{
            researchValidationLabel(item.validationStatus)
          }}</em>
        </div>
        <p>{{ getResearchCandidate(message, item.id)?.content ?? item.content }}</p>
        <div class="ai-research-result__validation">
          <span v-if="item.confidence !== null">
            置信度 {{ Math.round(item.confidence * 100) }}%
          </span>
          <small>{{ item.validationMessage }}</small>
        </div>
        <div v-if="item.sources.length" class="ai-research-result__sources">
          <button
            v-for="(source, sourceIndex) in item.sources"
            :key="`${item.id}:${source.documentId}:${source.blockId}:${source.revision}:${sourceIndex}`"
            type="button"
            :title="source.quote"
            @click="emit('open-source', source.documentId, source.blockId)"
          >
            <FileText :size="13" />来源 {{ sourceIndex + 1 }} · r{{ source.revision }}
          </button>
        </div>
        <template v-if="getResearchCandidate(message, item.id)">
          <form
            v-if="
              editingResearchCandidateId === getResearchCandidate(message, item.id)!.candidateId
            "
            class="ai-research-candidate__editor"
            @submit.prevent="
              decideResearchCandidate(
                message,
                getResearchCandidate(message, item.id)!,
                'approve',
                true,
              )
            "
          >
            <input v-model="researchCandidateTitle" maxlength="200" aria-label="候选标题" />
            <textarea v-model="researchCandidateContent" rows="4" aria-label="候选内容"></textarea>
            <div>
              <button type="button" @click="cancelResearchCandidateEdit">取消</button>
              <button
                type="submit"
                :disabled="!researchCandidateTitle.trim() || !researchCandidateContent.trim()"
              >
                <Check :size="13" />编辑后接受
              </button>
            </div>
          </form>
          <div v-else class="ai-research-candidate__decision">
            <span :class="`is-${getResearchCandidate(message, item.id)!.decision}`">
              {{ researchCandidateDecisionLabel(getResearchCandidate(message, item.id)!) }}
              · v{{ getResearchCandidate(message, item.id)!.version }}
            </span>
            <template
              v-if="
                getResearchCandidate(message, item.id)!.decision === 'pending' ||
                getResearchCandidate(message, item.id)!.decision === 'kept'
              "
            >
              <button
                type="button"
                :disabled="getResearchCandidate(message, item.id)!.sourceState === 'stale'"
                @click="
                  decideResearchCandidate(
                    message,
                    getResearchCandidate(message, item.id)!,
                    'approve',
                  )
                "
              >
                <Check :size="13" />接受
              </button>
              <button
                type="button"
                :disabled="getResearchCandidate(message, item.id)!.sourceState === 'stale'"
                @click="startResearchCandidateEdit(getResearchCandidate(message, item.id)!)"
              >
                <Pencil :size="13" />编辑
              </button>
              <button
                v-if="getResearchCandidate(message, item.id)!.decision !== 'kept'"
                type="button"
                @click="
                  decideResearchCandidate(message, getResearchCandidate(message, item.id)!, 'keep')
                "
              >
                保留
              </button>
              <button
                type="button"
                @click="
                  decideResearchCandidate(
                    message,
                    getResearchCandidate(message, item.id)!,
                    'reject',
                  )
                "
              >
                <X :size="13" />拒绝
              </button>
            </template>
          </div>
          <p
            v-if="getResearchCandidate(message, item.id)!.error"
            class="ai-research-candidate__error"
            role="alert"
          >
            {{ getResearchCandidate(message, item.id)!.error }}
          </p>
        </template>
      </li>
    </ol>
    <section v-if="message.researchResult.relations.length" class="ai-research-result__relations">
      <strong><GitFork :size="13" />发现关系</strong>
      <ol>
        <li
          v-for="(relation, relationIndex) in message.researchResult.relations"
          :key="`${message.id}:relation:${relationIndex}`"
        >
          <span>{{ relation.fromItemId }}</span>
          <b>{{ researchRelationLabel(relation.relationType) }}</b>
          <span>{{ relation.toItemId }}</span>
          <small>{{ relation.explanation }}</small>
        </li>
      </ol>
    </section>
    <section
      v-if="message.researchResult.unresolvedQuestions.length"
      class="ai-research-result__questions"
    >
      <strong>未解决问题</strong>
      <ul>
        <li v-for="question in message.researchResult.unresolvedQuestions" :key="question">
          {{ question }}
        </li>
      </ul>
    </section>
    <footer v-if="message.cognitiveProvenance">
      {{ message.cognitiveProvenance.outputContractId }} v1 · mode v{{
        message.cognitiveProvenance.modeVersion
      }}
    </footer>
  </div>
  <div
    v-if="message.learningResult && message.learningState"
    class="ai-learning-result"
    aria-label="学习反馈"
  >
    <header class="ai-learning-result__header">
      <span><BookOpen :size="15" /><b>/learning</b> 学习反馈</span>
      <small>
        {{ learningStateLabel(message.learningState.understandingState) }} ·
        {{ message.learningState.attempts.length }} 次尝试
      </small>
    </header>
    <div
      v-if="
        message.learningResult.feedback.correctPoints.length ||
        message.learningResult.feedback.omissions.length ||
        message.learningResult.feedback.misconceptions.length
      "
      class="ai-learning-result__feedback"
    >
      <section v-if="message.learningResult.feedback.correctPoints.length" class="is-correct">
        <strong><CircleCheck :size="14" />已掌握</strong>
        <ul>
          <li v-for="point in message.learningResult.feedback.correctPoints" :key="point">
            {{ point }}
          </li>
        </ul>
      </section>
      <section v-if="message.learningResult.feedback.omissions.length" class="is-omission">
        <strong><CircleHelp :size="14" />仍有遗漏</strong>
        <ul>
          <li v-for="point in message.learningResult.feedback.omissions" :key="point">
            {{ point }}
          </li>
        </ul>
      </section>
      <section
        v-if="message.learningResult.feedback.misconceptions.length"
        class="is-misconception"
      >
        <strong><CircleX :size="14" />需要纠正</strong>
        <ul>
          <li v-for="point in message.learningResult.feedback.misconceptions" :key="point">
            {{ point }}
          </li>
        </ul>
      </section>
    </div>
    <p v-if="message.learningResult.evidence" class="ai-learning-result__evidence">
      <Quote :size="14" aria-hidden="true" />
      <span><strong>判断依据</strong>{{ message.learningResult.evidence }}</span>
    </p>
    <section
      v-if="message.learningResult.nextPrompt.kind !== 'none'"
      class="ai-learning-result__next"
    >
      <Lightbulb :size="16" aria-hidden="true" />
      <div>
        <span> 下一步 · 提示级别 {{ message.learningResult.nextPrompt.hintLevel }}/3 </span>
        <p>{{ message.learningResult.nextPrompt.content }}</p>
      </div>
    </section>
    <section
      v-if="message.learningResult.candidateUnderstanding"
      class="ai-learning-result__candidate"
    >
      <Brain :size="16" aria-hidden="true" />
      <div>
        <span>候选理解记录</span>
        <strong>{{ message.learningResult.candidateUnderstanding.title }}</strong>
        <p>{{ message.learningResult.candidateUnderstanding.content }}</p>
        <small>
          置信度
          {{ Math.round(message.learningResult.candidateUnderstanding.confidence * 100) }}% ·
          未写入正式知识
        </small>
      </div>
    </section>
    <footer v-if="message.cognitiveProvenance">
      {{ message.cognitiveProvenance.outputContractId }} v1 · session
      {{ message.cognitiveProvenance.sessionId }}
    </footer>
  </div>
  <div v-if="message.reviewResult" class="ai-review-result" aria-label="结构化审阅结果">
    <header class="ai-review-result__header">
      <span><ListChecks :size="15" /><b>/review</b> 审阅结果</span>
      <small>{{ message.reviewResult.issues.length }} 个问题 · 只读</small>
    </header>
    <section class="ai-structured-result__summary">
      <span>审阅摘要</span>
      <p>{{ message.reviewResult.summary }}</p>
    </section>
    <ol class="ai-review-result__issues">
      <li
        v-for="(issue, issueIndex) in message.reviewResult.issues"
        :key="`${message.id}:${issue.id}`"
        :class="[`is-${issue.severity}`, `source-${issue.sourceState}`]"
      >
        <div class="ai-review-result__issue-head">
          <span class="ai-structured-result__index">{{ issueIndex + 1 }}</span>
          <span class="ai-structured-result__tag">{{ reviewIssueLabel(issue.issueType) }}</span>
          <strong>{{ issue.title }}</strong>
          <em :class="`is-${issue.severity}`">{{
            `严重度 ${reviewSeverityLabel(issue.severity)}`
          }}</em>
        </div>
        <p>{{ issue.explanation }}</p>
        <blockquote v-if="issue.affectedText">
          <span>涉及原文</span>{{ issue.affectedText }}
        </blockquote>
        <div class="ai-review-result__suggestion">
          <Lightbulb :size="14" aria-hidden="true" />
          <span><b>建议</b>{{ issue.suggestedAction }}</span>
        </div>
        <div v-if="issue.sources.length" class="ai-review-result__sources">
          <button
            v-for="(source, sourceIndex) in issue.sources"
            :key="`${issue.id}:${source.documentId}:${source.blockId}:${source.revision}:${sourceIndex}`"
            type="button"
            :title="source.quote"
            @click="emit('open-source', source.documentId, source.blockId)"
          >
            <FileText :size="13" />来源 {{ sourceIndex + 1 }} · r{{ source.revision }}
          </button>
          <span v-if="issue.sourceState === 'stale'">来源已变化</span>
        </div>
        <div class="ai-review-result__actions">
          <button
            type="button"
            :disabled="issue.sourceState === 'stale' || isRunning"
            @click="emit('resolve-review-issue', { messageId: message.id, issue })"
          >
            <Pencil :size="13" />处理此问题
          </button>
        </div>
      </li>
    </ol>
    <section
      v-if="message.reviewResult.unresolvedQuestions.length"
      class="ai-review-result__questions"
    >
      <strong>未解决问题</strong>
      <ul>
        <li v-for="question in message.reviewResult.unresolvedQuestions" :key="question">
          {{ question }}
        </li>
      </ul>
    </section>
    <footer v-if="message.cognitiveProvenance">
      {{ message.cognitiveProvenance.outputContractId }} v1 · mode v{{
        message.cognitiveProvenance.modeVersion
      }}
    </footer>
  </div>
</template>
