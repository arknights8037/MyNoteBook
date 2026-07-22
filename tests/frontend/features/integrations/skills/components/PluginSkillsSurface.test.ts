import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import PluginSkillsSurface from '@/features/integrations/skills/components/PluginSkillsSurface.vue'
import type { McpClientPort } from '@/services/ports/McpClientPort'

const mcpClient = {} as McpClientPort

describe('PluginSkillsSurface', () => {
  it('shows one extension category at a time and switches with accessible tabs', async () => {
    const wrapper = mount(PluginSkillsSurface, {
      props: { mcpClient },
      global: { stubs: { Teleport: true } },
    })
    await flushPromises()

    expect(wrapper.find('.skill-library:not(.mcp-panel)').exists()).toBe(true)
    expect(wrapper.find('.mcp-panel').exists()).toBe(false)
    expect(wrapper.find('.builtin-plugins').exists()).toBe(false)

    const tabs = wrapper.findAll('[role="tab"]')
    await tabs.find((tab) => tab.text().includes('MCP Client'))?.trigger('click')
    expect(wrapper.find('.mcp-panel.skill-library').exists()).toBe(true)
    expect(wrapper.find('.mcp-panel .skill-library__toolbar').exists()).toBe(true)
    expect(wrapper.find('.mcp-panel .skill-workbench').exists()).toBe(true)
    expect(wrapper.find('.skill-library:not(.mcp-panel)').exists()).toBe(false)

    await tabs.find((tab) => tab.text().includes('MCP Server'))?.trigger('click')
    expect(wrapper.find('.mcp-exposure').exists()).toBe(true)
    expect(wrapper.findAll('.mcp-exposure__tool')).toHaveLength(8)
    expect(wrapper.text()).toContain('list_agent_projects')
    expect(wrapper.text()).toContain('create_agent_branch')
    expect(wrapper.text()).toContain('关闭后的缺失')
    expect(wrapper.text()).toContain('开启后的风险')

    await tabs.find((tab) => tab.text().includes('内置插件'))?.trigger('click')
    expect(wrapper.find('.builtin-plugins').exists()).toBe(true)
    expect(wrapper.find('.mcp-panel').exists()).toBe(false)
  })
})
