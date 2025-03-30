import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile, Modal } from 'obsidian';
import { MRViewerView, VIEW_TYPE_MR_VIEWER } from './MRViewerView';

interface MRViewerSettings {
    defaultWindowLevel: number;
    defaultWindowWidth: number;
    defaultBrightness: number;
    defaultContrast: number;
    savedSeriesData: {
        [key: string]: {
            name: string;
            frames: {
                name: string;
                frameNumber: number;
                position: number;
                data: string; // Base64 编码的图像数据
            }[];
            sliceThickness: number;
            sliceSpacing: number;
            positions: number[];
        };
    };
}

const DEFAULT_SETTINGS: MRViewerSettings = {
    defaultWindowLevel: 128,
    defaultWindowWidth: 255,
    defaultBrightness: 100,
    defaultContrast: 100,
    savedSeriesData: {}
}

export default class MRViewerPlugin extends Plugin {
    settings: MRViewerSettings;

    async onload() {
        await this.loadSettings();

        // 注册视图
        this.registerView(
            VIEW_TYPE_MR_VIEWER,
            (leaf) => new MRViewerView(leaf, this)
        );

        // 添加命令
        this.addCommand({
            id: 'open-mr-viewer',
            name: '打开MR图像查看器',
            callback: () => {
                this.activateView();
            }
        });

        // 添加清除数据命令
        this.addCommand({
            id: 'clear-mr-viewer-data',
            name: '清除MR图像查看器数据',
            callback: () => {
                this.clearSavedData();
            }
        });

        // 添加设置选项卡
        this.addSettingTab(new MRViewerSettingTab(this.app, this));

        // 添加右键菜单
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                const fileExt = file.path.split('.').pop()?.toLowerCase();
                if (fileExt === 'jpg' || fileExt === 'jpeg') {
                    menu.addItem((item) => {
                        item
                            .setTitle('在MR查看器中打开')
                            .setIcon('image')
                            .onClick(async () => {
                                await this.activateView();
                                const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MR_VIEWER);
                                if (leaves.length > 0) {
                                    const view = leaves[0].view as MRViewerView;
                                    if (view && file instanceof TFile) {
                                        await view.loadFile(file);
                                    }
                                }
                            });
                    });
                }
            })
        );

        // 添加侧边栏按钮
        this.addRibbonIcon('image', 'MR图像查看器', () => {
            this.activateView();
        });
    }

    async onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_MR_VIEWER);
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_MR_VIEWER);

        if (leaves.length > 0) {
            // 如果视图已经存在，激活它
            leaf = leaves[0];
            workspace.revealLeaf(leaf);
        } else {
            // 如果视图不存在，创建新的
            leaf = workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({
                    type: VIEW_TYPE_MR_VIEWER,
                    active: true,
                });
                workspace.revealLeaf(leaf);
            }
        }

        if (leaf) {
            workspace.setActiveLeaf(leaf, { focus: true });
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async clearSavedData() {
        this.settings.savedSeriesData = {};
        await this.saveSettings();
        
        // 通知所有打开的视图刷新
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MR_VIEWER);
        for (const leaf of leaves) {
            const view = leaf.view as MRViewerView;
            if (view) {
                view.clearView();
            }
        }
    }
}

class MRViewerSettingTab extends PluginSettingTab {
    plugin: MRViewerPlugin;

    constructor(app: App, plugin: MRViewerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();

        containerEl.createEl('h2', {text: 'MR图像查看器设置'});

        new Setting(containerEl)
            .setName('默认窗位')
            .setDesc('设置默认的窗位值')
            .addSlider(slider => slider
                .setValue(this.plugin.settings.defaultWindowLevel)
                .setLimits(0, 255, 1)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.defaultWindowLevel = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('默认窗宽')
            .setDesc('设置默认的窗宽值')
            .addSlider(slider => slider
                .setValue(this.plugin.settings.defaultWindowWidth)
                .setLimits(1, 255, 1)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.defaultWindowWidth = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('默认亮度')
            .setDesc('设置默认的亮度值')
            .addSlider(slider => slider
                .setValue(this.plugin.settings.defaultBrightness)
                .setLimits(0, 200, 1)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.defaultBrightness = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('默认对比度')
            .setDesc('设置默认的对比度值')
            .addSlider(slider => slider
                .setValue(this.plugin.settings.defaultContrast)
                .setLimits(0, 200, 1)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.defaultContrast = value;
                    await this.plugin.saveSettings();
                }));

        // 添加清除数据按钮
        new Setting(containerEl)
            .setName('清除保存的数据')
            .setDesc('清除所有保存的MR序列数据，这将释放存储空间')
            .addButton(button => button
                .setButtonText('清除数据')
                .setWarning()
                .onClick(async () => {
                    // 显示确认对话框
                    const modal = new Modal(this.app);
                    modal.titleEl.setText('确认清除数据');
                    modal.contentEl.setText('确定要清除所有保存的MR序列数据吗？此操作不可恢复。');
                    
                    // 添加按钮
                    const buttonContainer = modal.contentEl.createDiv('modal-button-container');
                    buttonContainer.style.display = 'flex';
                    buttonContainer.style.justifyContent = 'flex-end';
                    buttonContainer.style.gap = '10px';
                    buttonContainer.style.marginTop = '20px';
                    
                    const cancelButton = buttonContainer.createEl('button');
                    cancelButton.setText('取消');
                    cancelButton.onclick = () => modal.close();
                    
                    const confirmButton = buttonContainer.createEl('button');
                    confirmButton.setText('确定');
                    confirmButton.addClass('mod-warning');
                    confirmButton.onclick = () => {
                        this.plugin.clearSavedData();
                        modal.close();
                    };
                    
                    modal.open();
                }));
    }
} 