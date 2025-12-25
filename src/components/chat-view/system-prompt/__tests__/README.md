# 系统提示词组件测试

## 测试说明

本目录包含系统提示词快捷开关功能的测试文件。

## 测试文件

- `SystemPromptToggle.test.tsx` - 测试系统提示词切换按钮组件

## 运行测试

```bash
npm test -- SystemPromptToggle.test.tsx
```

## 测试覆盖

当前测试主要验证：
- 组件可以正确导入
- 组件导出正确的属性
- 组件可以接受 props 而不抛出错误

## 注意事项

由于项目使用 Jest 和 Node 环境，测试中需要 mock 所有依赖项，包括：
- React hooks (useState, useEffect, etc.)
- Context providers (useLanguage, PluginContext)
- UI 组件 (@radix-ui/react-popover, lucide-react)
- CSS 导入

测试中出现的 JSX 警告是正常的，因为我们在 Node 环境中运行测试，而不是浏览器环境。