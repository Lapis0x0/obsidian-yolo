## 1.6.1.1 Module Reliability & Regional Connectivity 🛠️

### 🧩 Module Delivery & Recovery

- Module update checks and downloads now prefer jsDelivr, with automatic fallback to GitHub when unavailable, improving installation and update reliability in mainland China and other network-restricted regions.
- Module failures now report actionable causes such as download timeouts, integrity verification errors, and activation failures. Retrying performs a fresh download and verification instead of ending with a generic activation error.
- Modules synchronized from another device are reconciled in the background without delaying YOLO startup. Missing module files are automatically downloaded and repaired, while an explicit user action immediately takes priority over background waiting.
- Uninstalling a module now starts immediately after clicking “Uninstall”, without an unnecessary second confirmation dialog.

### 📁 Path Compatibility

- YOLO root directories now support paths containing Chinese and other Unicode characters.

---

## 1.6.1.1 模块可靠性与区域网络优化 🛠️

### 🧩 模块交付与恢复

- 模块更新检查与下载现在会优先使用 jsDelivr，并在不可用时自动切换至 GitHub，提升中国大陆及其他网络受限地区的安装和更新速度与成功率。
- 模块失败时现在会明确展示下载超时、文件校验或启动失败等具体原因；重试会重新执行下载与校验，不再只显示模糊的“无法激活”错误。
- 从其他设备同步到达的模块会在后台完成协调，不再拖慢 YOLO 启动。模块文件缺失时会自动重新下载修复，用户主动操作也会立即优先于后台等待。
- 点击“卸载”后会立即执行模块卸载，不再显示多余的二次确认弹窗。

### 📁 路径兼容性

- YOLO 根目录现在支持包含中文及其他 Unicode 字符的路径。
