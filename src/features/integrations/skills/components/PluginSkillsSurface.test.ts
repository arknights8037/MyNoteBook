import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import PluginSkillsSurface from './PluginSkillsSurface.vue'

describe('PluginSkillsSurface', () => {
  it('shows one extension category at a time and switches with accessible tabs', async () => {
    const wrapper = mount(PluginSkillsSurface, {
      global: { stubs: { Teleport: true } },
    })
    await flushPromises()

    expect(wrapper.find('.skill-library').exists()).toBe(true)
    expect(wrapper.find('.mcp-panel').exists()).toBe(false)
    expect(wrapper.find('.builtin-plugins').exists()).toBe(false)

    const tabs = wrapper.findAll('[role="tab"]')
    await tabs.find((tab) => tab.text().includes('MCP 服务'))?.trigger('click')
    expect(wrapper.find('.mcp-panel').exists()).toBe(true)
    expect(wrapper.find('.skill-library').exists()).toBe(false)

    await tabs.find((tab) => tab.text().includes('内置插件'))?.trigger('click')
    expect(wrapper.find('.builtin-plugins').exists()).toBe(true)
    expect(wrapper.find('.mcp-panel').exists()).toBe(false)
  })
})
