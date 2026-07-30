import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createInformationHome } from '@/models/home/informationHome'
import { ok } from '@/models/shared/result'

const home = createInformationHome((prefix) => `${prefix}-test`, 10)
const homeService = vi.hoisted(() => ({
  getOrCreate: vi.fn(),
  listSummaries: vi.fn(),
  savePayload: vi.fn(),
  shouldGenerateAutomatically: vi.fn(() => false),
}))
const emailService = vi.hoisted(() => ({
  listAccounts: vi.fn(async () => ({ ok: true, value: [] })),
  listMessages: vi.fn(async () => ({ ok: true, value: [] })),
}))
const rssService = vi.hoisted(() => ({
  listSources: vi.fn(async () => ({ ok: true, value: [] })),
  listEntries: vi.fn(async () => ({ ok: true, value: [] })),
}))

vi.mock('@/app/composition/informationHomeServiceFactory', () => ({
  createInformationHomeService: vi.fn(async () => homeService),
}))
vi.mock('@/app/composition/emailServiceFactory', () => ({
  createEmailService: vi.fn(async () => emailService),
}))
vi.mock('@/app/composition/rssServiceFactory', () => ({
  createRssService: vi.fn(async () => rssService),
}))

describe('InformationHomeSurface', () => {
  afterEach(() => Reflect.deleteProperty(globalThis, '__TAURI_INTERNALS__'))

  it('keeps management actions in the menu and only save/cancel at the bottom', async () => {
    Reflect.set(globalThis, '__TAURI_INTERNALS__', {})
    homeService.getOrCreate.mockResolvedValue(ok(home))
    homeService.listSummaries.mockResolvedValue(ok([]))
    const { default: InformationHomeSurface } =
      await import('@/features/information-home/components/InformationHomeSurface.vue')
    const wrapper = mount(InformationHomeSurface, {
      props: {
        aiSettings: {} as never,
        ensureAiSecretLoaded: vi.fn(async () => false),
      },
      global: {
        stubs: {
          InformationHomeGrid: { template: '<div data-test="home-grid" />' },
        },
      },
    })
    await flushPromises()

    expect(wrapper.find('.information-home-controls').exists()).toBe(false)
    expect(wrapper.find('[aria-label="信息面板菜单"]').exists()).toBe(false)
    await wrapper.get('.information-home-surface').trigger('contextmenu', {
      clientX: 140,
      clientY: 180,
    })
    expect(wrapper.get('[role="menu"]').text()).toContain('编辑布局')
    expect(wrapper.get('[role="menu"]').text()).toContain('添加卡片')
    expect(wrapper.get('[role="menu"]').attributes('style')).toContain('left: 140px')

    const addButton = wrapper
      .findAll('[role="menuitem"]')
      .find((button) => button.text().includes('添加卡片'))
    await addButton?.trigger('click')
    expect(wrapper.get('[aria-label="添加卡片"]').text()).toContain('待办列表')
    const todoButton = wrapper
      .findAll('[aria-label="添加卡片"] [role="menuitem"]')
      .find((button) => button.text().includes('待办列表'))
    await todoButton?.trigger('click')

    expect(
      wrapper.findAll('.information-home-controls button').map((button) => button.text()),
    ).toEqual(['取消', '保存布局'])

    await wrapper.get('.information-home-surface').trigger('contextmenu', {
      clientX: 160,
      clientY: 200,
    })
    const layoutButton = wrapper
      .findAll('[role="menuitem"]')
      .find((button) => button.text().includes('布局操作'))
    await layoutButton?.trigger('click')
    expect(wrapper.get('[aria-label="布局操作"]').text()).toContain('撤销')
    expect(wrapper.get('[aria-label="布局操作"]').text()).toContain('恢复默认')
    wrapper.unmount()
  })

  it('enters a reversible edit session when a widget requests removal', async () => {
    Reflect.set(globalThis, '__TAURI_INTERNALS__', {})
    homeService.getOrCreate.mockResolvedValue(ok(home))
    homeService.listSummaries.mockResolvedValue(ok([]))
    const { default: InformationHomeSurface } =
      await import('@/features/information-home/components/InformationHomeSurface.vue')
    const wrapper = mount(InformationHomeSurface, {
      props: {
        aiSettings: {} as never,
        ensureAiSecretLoaded: vi.fn(async () => false),
      },
      global: {
        stubs: {
          InformationHomeGrid: {
            emits: ['remove'],
            template:
              '<button data-test="remove-widget" @click="$emit(\'remove\', \'home-widget-test\')">remove</button>',
          },
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-test="remove-widget"]').trigger('click')
    expect(
      wrapper.findAll('.information-home-controls button').map((button) => button.text()),
    ).toEqual(['取消', '保存布局'])
    expect(
      wrapper.get('.information-home-controls .is-primary').attributes('disabled'),
    ).toBeUndefined()
    wrapper.unmount()
  })

  it('commits the final grid resize into the controlled draft layout', async () => {
    Reflect.set(globalThis, '__TAURI_INTERNALS__', {})
    homeService.getOrCreate.mockResolvedValue(ok(home))
    homeService.listSummaries.mockResolvedValue(ok([]))
    const { default: InformationHomeSurface } =
      await import('@/features/information-home/components/InformationHomeSurface.vue')
    const wrapper = mount(InformationHomeSurface, {
      props: {
        aiSettings: {} as never,
        ensureAiSecretLoaded: vi.fn(async () => false),
      },
      global: {
        stubs: {
          InformationHomeGrid: {
            name: 'InformationHomeGrid',
            props: ['widgets'],
            emits: ['resize'],
            template:
              "<div><button data-test=\"resize-widget\" @click=\"$emit('resize', 'home-widget-test', { w: 8, h: 7 }, 'desktop')\">resize</button><button data-test=\"resize-widget-compact\" @click=\"$emit('resize', 'home-widget-test', { w: 8, h: 6 }, 'compact')\">compact</button></div>",
          },
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-test="resize-widget"]').trigger('click')
    const widgets = wrapper
      .getComponent({ name: 'InformationHomeGrid' })
      .props('widgets') as typeof home.payload.widgets
    expect(widgets[0]?.layout.desktop).toMatchObject({ w: 8, h: 7 })
    await wrapper.get('[data-test="resize-widget-compact"]').trigger('click')
    const compactWidgets = wrapper
      .getComponent({ name: 'InformationHomeGrid' })
      .props('widgets') as typeof home.payload.widgets
    expect(compactWidgets[0]?.layout.compact).toMatchObject({ x: 0, w: 6, h: 6 })
    expect(wrapper.find('.information-home-controls').exists()).toBe(true)
    wrapper.unmount()
  })
})
