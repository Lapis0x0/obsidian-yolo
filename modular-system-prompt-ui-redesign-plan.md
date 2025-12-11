# 模块化系统提示词UI重设计划

## 目标
参考Providers和Chat models设置项的UI风格，以及编辑提示词的弹窗，改进模块化系统提示词的UI界面，保持原有组件功能，只修改UI和拖拽方式。

## 分析结果

### Providers和Chat models设置项的UI特点

1. **ProviderSectionItem**:
   - 使用表格布局展示模型列表
   - 拖拽手柄使用GripVertical图标
   - 展开/收起使用ChevronDown/ChevronRight图标
   - 操作按钮使用Settings和Trash2图标
   - 使用ObsidianToggle组件进行启用/禁用切换
   - 拖拽时有视觉反馈（透明度变化、阴影效果）

2. **ChatModelRow**:
   - 表格行布局，包含拖拽手柄、名称、ID、启用状态、操作按钮
   - 使用Edit和Trash2图标进行编辑和删除操作
   - 拖拽时有视觉反馈

### 编辑提示词弹窗的UI特点

1. **PromptEditModal**:
   - 自定义模态框布局，包含头部、内容区、底部操作区
   - 头部包含标题、统计信息、关闭按钮
   - 内容区包含文本编辑区和编辑提示
   - 底部包含重置、取消、保存按钮
   - 支持键盘快捷键（Ctrl+S保存、Esc取消等）

### ProviderFormModal和AddChatModelModal的UI特点

1. **ProviderFormModal**:
   - 使用ObsidianSetting组件组织表单字段
   - 使用ObsidianTextInput、ObsidianDropdown、ObsidianToggle等组件
   - 底部有添加/保存和取消按钮

2. **AddChatModelModal**:
   - 同样使用ObsidianSetting组件组织表单
   - 包含搜索下拉框、文本输入、下拉选择等
   - 支持动态添加自定义参数

## 修改计划

### 1. 修改ModularSystemPromptSection组件

**当前问题**:
- 布局不够结构化，缺少表格风格
- 添加按钮样式不一致

**修改方案**:
- 参考ProvidersAndModelsSection的整体结构
- 使用smtcmp-settings-section作为主容器
- 添加smtcmp-settings-header和smtcmp-settings-desc
- 使用smtcmp-providers-models-container风格的容器
- 统一添加按钮样式

### 2. 修改PromptGroupItem组件

**当前问题**:
- 布局不够紧凑，与ProviderSectionItem风格不一致
- 拖拽手柄样式不统一
- 操作按钮布局和样式不一致

**修改方案**:
- 参考ProviderSectionItem的布局结构
- 使用GripVertical图标作为拖拽手柄
- 调整头部布局，使其更紧凑
- 统一操作按钮样式和位置
- 添加表格风格的边框和背景

### 3. 修改PromptModuleItem组件

**当前问题**:
- 布局不够表格化，与ChatModelRow风格不一致
- 拖拽手柄样式不统一
- 操作按钮样式不一致

**修改方案**:
- 参考ChatModelRow的表格行布局
- 使用GripVertical图标作为拖拽手柄
- 调整为表格行样式，包含拖拽手柄、名称、启用状态、操作按钮列
- 统一操作按钮样式和位置

### 4. 修改PromptEditModal组件

**当前问题**:
- 自定义模态框样式与Obsidian标准不一致
- 缺少ObsidianSetting组件的使用

**修改方案**:
- 参考ProviderFormModal的结构
- 使用ObsidianSetting组件组织表单字段
- 使用ObsidianTextArea替代原生textarea
- 统一按钮样式和布局

### 5. 更新styles.css

**修改方案**:
- 统一颜色变量和间距
- 添加表格风格的边框和背景
- 统一拖拽手柄样式
- 统一按钮悬停效果
- 添加拖拽反馈动画

### 6. 测试拖拽功能

**测试点**:
- 分组拖拽排序功能
- 提示词拖拽排序功能
- 拖拽视觉反馈
- 拖拽后的状态更新

## 具体实现细节

### ModularSystemPromptSection修改要点

```tsx
// 参考ProvidersAndModelsSection的结构
return (
  <div className="smtcmp-settings-section">
    <div className="smtcmp-settings-header">
      {t('settings.systemPrompt.title')}
    </div>
    
    <div className="smtcmp-settings-desc">
      <span>{t('settings.systemPrompt.desc')}</span>
    </div>

    <div className="smtcmp-providers-models-container">
      {/* 模式切换 */}
      <div className="smtcmp-mode-toggle-container">
        <ModeToggle mode={displayMode} onModeChange={handleModeChange} />
      </div>
      
      {/* 分组列表 */}
      {displayMode === DisplayMode.MODULAR && (
        <DndContext onDragEnd={handleDragEnd}>
          <PromptGroupList ... />
        </DndContext>
      )}
      
      {/* 添加分组按钮 */}
      {displayMode === DisplayMode.MODULAR && (
        <button className="smtcmp-add-provider-btn">
          + {t('settings.systemPrompt.addGroup')}
        </button>
      )}
      
      {/* 预览模式 */}
      {displayMode === DisplayMode.PREVIEW && (
        <ModularSystemPromptPreview ... />
      )}
    </div>
  </div>
)
```

### PromptGroupItem修改要点

```tsx
// 参考ProviderSectionItem的布局
return (
  <div className="smtcmp-provider-section">
    <div className="smtcmp-provider-header smtcmp-clickable">
      {/* 拖拽手柄 */}
      <span className="smtcmp-provider-drag-handle" {...listeners}>
        <GripVertical />
      </span>

      {/* 展开/收起按钮 */}
      <div className="smtcmp-provider-expand-btn">
        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </div>

      {/* 分组信息 */}
      <div className="smtcmp-provider-info">
        <span className="smtcmp-provider-id">{group.name}</span>
        <span className="smtcmp-provider-type">
          {t('settings.systemPrompt.enabledPrompts')}: {groupStats}
        </span>
      </div>

      {/* 操作按钮 */}
      <div className="smtcmp-provider-actions">
        <ObsidianToggle value={group.enabled} onChange={onToggleGroup} />
        <button className="clickable-icon" onClick={onDeleteGroup}>
          <Trash2 />
        </button>
      </div>
    </div>

    {/* 分组内容 */}
    {isExpanded && (
      <div className="smtcmp-provider-models">
        <PromptModuleList ... />
        <button className="smtcmp-add-model-btn">
          + {t('settings.systemPrompt.addPrompt')}
        </button>
      </div>
    )}
  </div>
)
```

### PromptModuleItem修改要点

```tsx
// 参考ChatModelRow的表格行布局
return (
  <tr className="smtcmp-model-row">
    <td>
      <span className="smtcmp-drag-handle" {...listeners}>
        <GripVertical />
      </span>
    </td>
    <td title={prompt.name}>{prompt.name}</td>
    <td>
      <ObsidianToggle
        value={prompt.enabled}
        onChange={(value) => onTogglePrompt(prompt.id, value)}
      />
    </td>
    <td>
      <div className="smtcmp-settings-actions">
        <button
          onClick={() => setIsEditingContent(true)}
          className="clickable-icon"
          title="Edit prompt"
        >
          <Edit />
        </button>
        <button
          onClick={() => onDeletePrompt(prompt.id)}
          className="clickable-icon"
          title="Delete prompt"
        >
          <Trash2 />
        </button>
      </div>
    </td>
  </tr>
)
```

### PromptEditModal修改要点

```tsx
// 参考ProviderFormModal的结构
return (
  <>
    <ObsidianSetting
      name={t('settings.systemPrompt.editPrompt')}
      desc={`${t('settings.systemPrompt.wordCount')}: ${wordCount}, ${t('settings.systemPrompt.charCount')}: ${charCount}`}
    >
      <ObsidianTextArea
        value={content}
        onChange={(value) => setContent(value)}
        placeholder={t('settings.systemPrompt.promptContentPlaceholder')}
        rows={20}
      />
    </ObsidianSetting>

    <ObsidianSetting>
      <ObsidianButton
        text={t('settings.systemPrompt.reset')}
        onClick={handleReset}
        disabled={content === prompt.content}
      />
      <ObsidianButton text={t('common.cancel')} onClick={handleCancel} />
      <ObsidianButton
        text={t('common.save')}
        onClick={handleSave}
        disabled={!content.trim() || content.trim() === prompt.content}
        cta
      />
    </ObsidianSetting>
  </>
)
```

## 样式统一要点

1. **颜色和间距**:
   - 使用Obsidian的CSS变量
   - 统一边框颜色和背景色
   - 统一内边距和外边距

2. **拖拽手柄**:
   - 使用GripVertical图标
   - 统一大小和颜色
   - 统一悬停效果

3. **按钮样式**:
   - 使用clickable-icon类
   - 统一大小和间距
   - 统一悬停效果

4. **表格样式**:
   - 使用smtcmp-models-table类
   - 统一列宽和对齐
   - 统一边框和背景

## 实施步骤

1. 修改ModularSystemPromptSection组件的整体结构
2. 修改PromptGroupItem组件，使其更像ProviderSectionItem
3. 修改PromptModuleItem组件，使其更像ChatModelRow
4. 修改PromptEditModal组件，使其更像ProviderFormModal
5. 更新styles.css，统一所有样式
6. 测试拖拽功能和交互

## 注意事项

1. 保持原有功能不变，只修改UI
2. 确保拖拽功能正常工作
3. 保持响应式设计
4. 确保无障碍访问性
5. 保持与Obsidian设计规范的一致性