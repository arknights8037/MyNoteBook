<script setup lang="ts">
import { open } from '@tauri-apps/plugin-dialog'
import { openPath } from '@tauri-apps/plugin-opener'
import {
  AlertTriangle,
  Blocks,
  Cable,
  Check,
  ChevronRight,
  Code2,
  File,
  FileText,
  Folder,
  FolderOpen,
  PackagePlus,
  Plus,
  Puzzle,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
} from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import type { InstalledSkill, SkillFileEntry } from '@/models/skill'
import { listBuiltinPlugins } from '@/plugins/pluginRegistry'
import {
  createSkill,
  getSkillsDirectory,
  importSkillDirectory,
  listInstalledSkills,
  readSkillFile,
  removeInstalledSkill,
  setSkillEnabled,
  writeSkillFile,
} from '@/services/SkillService'
import { NButton, NIcon, NInput, NModal } from '@/ui'
import { useMessage } from '@/ui/services'
import McpServersPanel from '@/features/integrations/mcp/components/McpServersPanel.vue'

const plugins = listBuiltinPlugins()
const message = useMessage()
const skills = ref<InstalledSkill[]>([])
const selectedSkillId = ref('')
const selectedFilePath = ref('')
const fileContent = ref('')
const fileDraft = ref('')
const query = ref('')
const filter = ref<'all' | 'enabled' | 'invalid'>('all')
const activeTab = ref<'skills' | 'mcp' | 'builtin'>('skills')
const filterOptions: Array<{ value: 'all' | 'enabled' | 'invalid'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'enabled', label: '已启用' },
  { value: 'invalid', label: '需修复' },
]
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const showCreateModal = ref(false)
const draftName = ref('')
const draftDescription = ref('')
type BrowserEvent = InstanceType<typeof globalThis.Event>
type BrowserInputElement = InstanceType<typeof globalThis.HTMLInputElement>

const isNative = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const enabledCount = computed(() => skills.value.filter((skill) => skill.enabled).length)
const extensionTabs = computed(() => [
  {
    id: 'skills' as const,
    label: 'Skills',
    description: '教会 Agent 如何完成特定工作',
    count: skills.value.length,
    icon: Code2,
  },
  {
    id: 'mcp' as const,
    label: 'MCP 服务',
    description: '连接外部工具与数据源',
    count: null,
    icon: Cable,
  },
  {
    id: 'builtin' as const,
    label: '内置插件',
    description: '查看应用自带能力',
    count: plugins.length,
    icon: Puzzle,
  },
])
const activeTabGuide = computed(() =>
  ({
    skills: {
      title: '想让 Agent 学会一套固定做法？从 Skill 开始',
      description: '新建一个简单 Skill，或导入已有的 SKILL.md 目录；启用后 Agent 会在合适的任务中按需读取。',
    },
    mcp: {
      title: '需要连接其他应用或数据？配置 MCP 服务',
      description: 'MCP 服务可以提供工具和只读资源。首次使用建议只添加你信任的本地服务。',
    },
    builtin: {
      title: '这些能力已经随应用安装',
      description: '内置插件无需配置。这里用于了解它们能做什么，以及可以使用哪些命令。',
    },
  })[activeTab.value],
)
const selectedSkill = computed(
  () => skills.value.find((skill) => skill.id === selectedSkillId.value) ?? null,
)
const selectedFile = computed(
  () => selectedSkill.value?.files.find((file) => file.path === selectedFilePath.value) ?? null,
)
const hasUnsavedChanges = computed(() => fileDraft.value !== fileContent.value)
const filteredSkills = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  return skills.value.filter((skill) => {
    if (filter.value === 'enabled' && !skill.enabled) return false
    if (filter.value === 'invalid' && skill.valid) return false
    return (
      !keyword ||
      `${skill.name} ${skill.description} ${skill.id}`.toLocaleLowerCase().includes(keyword)
    )
  })
})

const capabilityLabels: Record<string, string> = {
  'document:read': '读取内容',
  'document:write': '编辑内容',
  'document:export': '导出内容',
  'repository:read': '读取仓库',
  'repository:write': '写入仓库',
}

function fileDepth(file: SkillFileEntry): number {
  return Math.max(0, file.path.split('/').length - 1)
}

function setFilter(value: 'all' | 'enabled' | 'invalid'): void {
  filter.value = value
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function loadSkills(preferredSkillId = selectedSkillId.value): Promise<void> {
  if (!isNative) {
    error.value = 'Skill 目录管理需要在桌面应用中使用；浏览器预览仅展示内置插件。'
    return
  }
  loading.value = true
  error.value = ''
  try {
    skills.value = await listInstalledSkills()
    const next = skills.value.find((skill) => skill.id === preferredSkillId) ?? skills.value[0]
    if (next) await selectSkill(next, true)
    else clearSelection()
  } catch (loadError) {
    error.value = errorMessage(loadError)
  } finally {
    loading.value = false
  }
}

async function selectSkill(skill: InstalledSkill, force = false): Promise<void> {
  if (!force && !canLeaveEditor()) return
  selectedSkillId.value = skill.id
  const skillFile = skill.files.find(
    (file) => file.kind === 'file' && file.name.toLocaleLowerCase() === 'skill.md',
  )
  if (skillFile?.editable) await selectFile(skillFile, true)
  else clearFile()
}

async function selectFile(file: SkillFileEntry, force = false): Promise<void> {
  if (file.kind !== 'file') return
  if (!file.editable) {
    message.error('该文件是二进制文件、非 UTF-8 文本，或大小超过 1 MB。')
    return
  }
  if (!force && file.path !== selectedFilePath.value && !canLeaveEditor()) return
  if (!selectedSkill.value) return
  error.value = ''
  try {
    const content = await readSkillFile(selectedSkill.value.id, file.path)
    selectedFilePath.value = file.path
    fileContent.value = content
    fileDraft.value = content
  } catch (readError) {
    error.value = errorMessage(readError)
  }
}

function canLeaveEditor(): boolean {
  return !hasUnsavedChanges.value || globalThis.confirm('当前技能文件有未保存修改，确定放弃吗？')
}

function clearFile(): void {
  selectedFilePath.value = ''
  fileContent.value = ''
  fileDraft.value = ''
}

function clearSelection(): void {
  selectedSkillId.value = ''
  clearFile()
}

async function saveFile(): Promise<void> {
  if (!selectedSkill.value || !selectedFile.value || !hasUnsavedChanges.value) return
  saving.value = true
  error.value = ''
  try {
    await writeSkillFile(selectedSkill.value.id, selectedFile.value.path, fileDraft.value)
    fileContent.value = fileDraft.value
    message.success('技能文件已保存，将在下一次 Agent 任务中生效')
    await loadSkills(selectedSkill.value.id)
  } catch (saveError) {
    error.value = errorMessage(saveError)
  } finally {
    saving.value = false
  }
}

async function chooseImportDirectory(): Promise<void> {
  const selected = await open({
    title: '选择 Skill 目录或包含多个 Skill 的目录',
    directory: true,
    multiple: false,
  })
  if (typeof selected !== 'string' || !selected.trim()) return
  loading.value = true
  error.value = ''
  try {
    const imported = await importSkillDirectory(selected)
    message.success(`已导入 ${imported.length} 个 Skill`)
    await loadSkills(imported[0]?.id)
  } catch (importError) {
    error.value = errorMessage(importError)
  } finally {
    loading.value = false
  }
}

async function submitCreateSkill(): Promise<void> {
  if (!draftName.value.trim() || !draftDescription.value.trim()) {
    error.value = '请填写技能名称和用途描述。'
    return
  }
  loading.value = true
  error.value = ''
  try {
    const skill = await createSkill(draftName.value, draftDescription.value)
    draftName.value = ''
    draftDescription.value = ''
    showCreateModal.value = false
    message.success('已创建标准 SKILL.md 目录')
    await loadSkills(skill.id)
  } catch (createError) {
    error.value = errorMessage(createError)
  } finally {
    loading.value = false
  }
}

async function toggleSkill(skill: InstalledSkill, event: BrowserEvent): Promise<void> {
  const enabled = (event.target as BrowserInputElement).checked
  if (!skill.valid) return
  try {
    await setSkillEnabled(skill.id, enabled)
    skill.enabled = enabled
    message.success(enabled ? `已启用 ${skill.name}` : `已停用 ${skill.name}`)
  } catch (toggleError) {
    error.value = errorMessage(toggleError)
  }
}

async function removeSkill(skill: InstalledSkill): Promise<void> {
  if (!globalThis.confirm(`移除 Skill“${skill.name}”？这会删除应用数据目录中的技能副本。`)) return
  try {
    await removeInstalledSkill(skill.id)
    message.success('Skill 已移除')
    await loadSkills()
  } catch (removeError) {
    error.value = errorMessage(removeError)
  }
}

async function openSkillsFolder(): Promise<void> {
  try {
    await openPath(await getSkillsDirectory())
  } catch (openError) {
    error.value = errorMessage(openError)
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

onMounted(() => void loadSkills())
</script>

<template>
  <section class="plugin-skills-page" aria-label="插件技能">
    <header class="plugin-skills-page__header">
      <div>
        <span class="plugin-skills-page__eyebrow"><Sparkles :size="14" /> AGENT EXTENSIONS</span>
        <h1>插件与技能</h1>
        <p>兼容标准 SKILL.md 目录，并让 Agent 按需读取下属脚本、资料和资源。</p>
      </div>
      <div v-if="activeTab === 'skills'" class="plugin-skills-page__header-actions">
        <div class="plugin-skills-page__summary">
          <strong>{{ enabledCount }}</strong>
          <span>已启用 / {{ skills.length }} 个 Skill</span>
        </div>
        <NButton secondary :disabled="!isNative" @click="openSkillsFolder">
          <template #icon
            ><NIcon :size="15"><FolderOpen /></NIcon
          ></template>
          打开目录
        </NButton>
        <NButton
          type="primary"
          :disabled="!isNative"
          :loading="loading"
          @click="chooseImportDirectory"
        >
          <template #icon
            ><NIcon :size="15"><PackagePlus /></NIcon
          ></template>
          导入 Skill
        </NButton>
      </div>
    </header>

    <div class="plugin-skills-page__content">
      <nav class="surface-tabs" role="tablist" aria-label="扩展类型">
        <button
          v-for="tab in extensionTabs"
          :key="tab.id"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.id"
          :class="{ 'is-active': activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          <component :is="tab.icon" :size="17" />
          <span><strong>{{ tab.label }}</strong><small>{{ tab.description }}</small></span>
          <em v-if="tab.count !== null">{{ tab.count }}</em>
        </button>
      </nav>

      <aside class="surface-guide">
        <Sparkles :size="18" />
        <div><strong>{{ activeTabGuide.title }}</strong><p>{{ activeTabGuide.description }}</p></div>
      </aside>

      <McpServersPanel v-if="activeTab === 'mcp'" />
      <section v-else-if="activeTab === 'skills'" class="skill-library" aria-label="本地技能库">
        <div class="skill-library__toolbar">
          <NInput v-model:value="query" size="small" clearable placeholder="搜索技能">
            <template #prefix><Search :size="14" /></template>
          </NInput>
          <div class="skill-filter" aria-label="技能筛选">
            <button
              v-for="item in filterOptions"
              :key="item.value"
              type="button"
              :class="{ 'is-active': filter === item.value }"
              @click="setFilter(item.value)"
            >
              {{ item.label }}
            </button>
          </div>
          <NButton quaternary circle aria-label="刷新技能" :loading="loading" @click="loadSkills()">
            <template #icon
              ><NIcon :size="15"><RefreshCw /></NIcon
            ></template>
          </NButton>
          <NButton secondary :disabled="!isNative" @click="showCreateModal = true">
            <template #icon
              ><NIcon :size="15"><Plus /></NIcon
            ></template>
            新建
          </NButton>
        </div>

        <p v-if="error" class="skill-error" role="alert"><AlertTriangle :size="15" />{{ error }}</p>

        <div class="skill-workbench">
          <aside class="skill-list" aria-label="已安装 Skill">
            <div class="skill-list__heading">
              <strong>本地 Skills</strong><span>{{ filteredSkills.length }}</span>
            </div>
            <button
              v-for="skill in filteredSkills"
              :key="skill.id"
              type="button"
              class="skill-list-item"
              :class="{ 'is-active': selectedSkillId === skill.id }"
              @click="selectSkill(skill)"
            >
              <span class="skill-list-item__icon" :class="{ 'is-invalid': !skill.valid }">
                <Code2 v-if="skill.valid" :size="17" /><AlertTriangle v-else :size="17" />
              </span>
              <span class="skill-list-item__body">
                <span
                  ><strong>{{ skill.name }}</strong
                  ><small v-if="skill.version">v{{ skill.version }}</small></span
                >
                <small>{{ skill.description }}</small>
              </span>
              <label class="skill-switch" :title="skill.enabled ? '停用' : '启用'" @click.stop>
                <input
                  type="checkbox"
                  :checked="skill.enabled"
                  :disabled="!skill.valid"
                  @change="toggleSkill(skill, $event)"
                />
                <span aria-hidden="true"></span>
              </label>
            </button>
            <div v-if="filteredSkills.length === 0" class="skill-list__empty">
              <FileText :size="24" /><strong>还没有匹配的 Skill</strong
              ><span>导入含 SKILL.md 的目录即可开始。</span>
            </div>
          </aside>

          <main v-if="selectedSkill" class="skill-detail">
            <header class="skill-detail__header">
              <div>
                <span class="skill-detail__path">skills/{{ selectedSkill.id }}/SKILL.md</span>
                <h2>{{ selectedSkill.name }}</h2>
                <p>{{ selectedSkill.description }}</p>
              </div>
              <NButton quaternary circle aria-label="移除技能" @click="removeSkill(selectedSkill)">
                <template #icon
                  ><NIcon :size="15"><Trash2 /></NIcon
                ></template>
              </NButton>
            </header>
            <p v-if="selectedSkill.validationError" class="skill-validation">
              <AlertTriangle :size="14" />{{ selectedSkill.validationError }}
            </p>
            <div class="skill-detail__workspace">
              <nav class="skill-file-tree" aria-label="技能文件">
                <div class="skill-file-tree__heading">
                  <strong>FILES</strong
                  ><span>{{
                    selectedSkill.files.filter((file) => file.kind === 'file').length
                  }}</span>
                </div>
                <button
                  v-for="file in selectedSkill.files"
                  :key="file.path"
                  type="button"
                  :disabled="file.kind === 'directory'"
                  :class="{
                    'is-active': selectedFilePath === file.path,
                    'is-directory': file.kind === 'directory',
                  }"
                  :style="{ '--file-depth': fileDepth(file) }"
                  @click="selectFile(file)"
                >
                  <Folder v-if="file.kind === 'directory'" :size="14" />
                  <FileText v-else-if="file.editable" :size="14" />
                  <File v-else :size="14" />
                  <span>{{ file.name }}</span
                  ><small v-if="file.kind === 'file'">{{ formatBytes(file.sizeBytes) }}</small>
                </button>
              </nav>
              <section class="skill-editor" aria-label="技能文件编辑器">
                <header v-if="selectedFile">
                  <div>
                    <strong>{{ selectedFile.path }}</strong
                    ><span>{{ selectedFile.editable ? 'UTF-8 TEXT' : 'READ ONLY' }}</span>
                  </div>
                  <NButton
                    size="small"
                    type="primary"
                    :disabled="!hasUnsavedChanges"
                    :loading="saving"
                    @click="saveFile"
                  >
                    <template #icon
                      ><NIcon :size="14"><Save /></NIcon></template
                    >保存
                  </NButton>
                </header>
                <textarea
                  v-if="selectedFile?.editable"
                  v-model="fileDraft"
                  spellcheck="false"
                  :aria-label="`编辑 ${selectedFile.path}`"
                ></textarea>
                <div v-else class="skill-editor__empty">
                  <FileText :size="30" /><span>选择左侧文本文件查看和编辑</span>
                </div>
              </section>
            </div>
          </main>
          <main v-else class="skill-detail skill-detail--empty">
            <Blocks :size="34" />
            <h2>选择一个 Skill</h2>
            <p>查看标准目录结构、编辑 SKILL.md 或管理启用状态。</p>
          </main>
        </div>
      </section>

      <section v-else class="builtin-plugins" aria-label="内置插件">
        <div class="plugin-skills-page__section-heading">
          <span>内置插件</span><small>随应用提供，不使用 SKILL.md 目录</small>
        </div>
        <article v-for="plugin in plugins" :key="plugin.id" class="plugin-skill-row">
          <div class="plugin-skill-row__icon"><Puzzle :size="20" /></div>
          <div class="plugin-skill-row__body">
            <div class="plugin-skill-row__title">
              <strong>{{ plugin.name }}</strong
              ><span>v{{ plugin.version }}</span>
            </div>
            <p>{{ plugin.description }}</p>
            <div class="plugin-skill-row__capabilities">
              <span v-for="capability in plugin.capabilities" :key="capability"
                ><Check :size="12" />{{ capabilityLabels[capability] || capability }}</span
              >
            </div>
            <div class="plugin-skill-row__commands">
              <div v-for="command in plugin.commands" :key="command.id">
                <Blocks :size="15" /><span
                  ><strong>{{ command.title }}</strong
                  ><small>{{ command.description }}</small></span
                ><ChevronRight :size="15" />
              </div>
            </div>
          </div>
        </article>
      </section>
    </div>

    <NModal
      v-model:show="showCreateModal"
      preset="card"
      title="新建 Skill"
      class="create-skill-modal"
      :bordered="false"
    >
      <p>创建符合通用规范的目录和 SKILL.md，可继续添加 scripts、references、assets 等子目录。</p>
      <label
        ><span>技能名称</span
        ><NInput v-model:value="draftName" autofocus placeholder="例如：会议纪要整理"
      /></label>
      <label
        ><span>用途描述</span
        ><textarea
          v-model="draftDescription"
          rows="3"
          placeholder="说明何时应该使用这个技能，以及它能完成什么"
        ></textarea>
      </label>
      <template #footer
        ><div class="create-skill-modal__actions">
          <NButton @click="showCreateModal = false">取消</NButton
          ><NButton type="primary" :loading="loading" @click="submitCreateSkill">创建目录</NButton>
        </div></template
      >
    </NModal>
  </section>
</template>
