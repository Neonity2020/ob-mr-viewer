import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import MRViewerPlugin from './main';

export const VIEW_TYPE_MR_VIEWER = 'mr-viewer';

interface SeriesFrame {
    file: File;
    name: string;
    url: string;
    frameNumber: number;
    position: number;
}

interface SeriesData {
    name: string;
    frames: SeriesFrame[];
    sliceThickness: number;
    sliceSpacing: number;
    positions: number[];
}

interface ViewerData {
    element: HTMLElement;
    container: HTMLElement;
    images: HTMLImageElement[];
    currentActive: number;
    currentFrame: number;
    currentPosition: number;
    filenameDisplay: HTMLElement;
    activeIndicator: HTMLElement;
    fullscreenContainer?: HTMLElement;
}

export class MRViewerView extends ItemView {
    private container: HTMLElement;
    private fileInput: HTMLInputElement;
    private viewerContainer: HTMLElement;
    private multiViewer: HTMLElement;
    private seriesData: { [key: string]: SeriesData } = {};
    private activeViewers: { [key: string]: ViewerData } = {};
    private imageCache: { [key: string]: HTMLImageElement } = {};
    private currentFrameIndex = 0;
    private currentPosition = 0;
    private isPlaying = false;
    private playInterval: number | null = null;
    private playbackSpeed = 5;
    private syncEnabled = true;
    private syncMode = 'frame';
    private activeSeries: string | null = null;
    private lastWheelTime = 0;
    private wheelDelta = 0;
    private isViewCreated = false;
    private positionMap: {
        positions: number[];
        indexMap: { [key: number]: number };
        [key: string]: any;
    } = {
        positions: [],
        indexMap: {}
    };

    constructor(leaf: WorkspaceLeaf, private plugin: MRViewerPlugin) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE_MR_VIEWER;
    }

    getDisplayText(): string {
        return "MR图像查看器";
    }

    async onOpen() {
        // 获取容器引用
        this.container = this.containerEl.children[1] as HTMLElement;
        
        // 如果视图未创建，则创建视图
        if (!this.isViewCreated) {
            await this.createView();
        } else {
            // 如果视图已创建但需要重新显示数据
            await this.reloadView();
        }
    }

    private async createView() {
        // 清空容器
        this.container.empty();
        this.container.addClass('mr-viewer-container');

        // 创建基本布局
        this.createLayout();
        
        // 添加样式
        this.addStyles();
        
        // 绑定事件监听器
        this.bindEventListeners();

        // 标记视图已创建
        this.isViewCreated = true;

        // 如果有保存的数据，加载它
        const savedData = this.plugin.settings.savedSeriesData;
        if (savedData && Object.keys(savedData).length > 0) {
            await this.loadSavedSeriesData();
        }
    }

    private async reloadView() {
        // 清理现有数据但保持视图结构
        this.clearExistingData();

        // 重新加载保存的数据
        const savedData = this.plugin.settings.savedSeriesData;
        if (savedData && Object.keys(savedData).length > 0) {
            await this.loadSavedSeriesData();
        }
    }

    async onClose() {
        // 停止播放
        if (this.playInterval) {
            clearInterval(this.playInterval);
        }

        // 清理事件监听器
        window.removeEventListener('resize', this.handleResize.bind(this));
        
        // 清理全屏容器
        for (const seriesName in this.activeViewers) {
            const viewer = this.activeViewers[seriesName];
            if (viewer.fullscreenContainer) {
                viewer.fullscreenContainer.remove();
            }
        }

        // 清理资源但保持视图结构
        this.clearExistingData();

        // 隐藏查看器容器
        if (this.viewerContainer) {
            this.viewerContainer.style.display = 'none';
        }
    }

    private createLayout() {
        // 创建上传区域
        const uploadSection = this.container.createDiv('upload-section');
        uploadSection.createEl('h2', { text: '上传DICOM JPEG序列' });
        uploadSection.createEl('p', { text: '请选择包含MR序列的JPEG图像文件(可多选)' });
        
        this.fileInput = uploadSection.createEl('input', {
            type: 'file',
            attr: {
                multiple: true,
                accept: 'image/jpeg'
            }
        });
        this.fileInput.style.display = 'none';
        
        const uploadButton = uploadSection.createEl('button', {
            cls: 'upload-btn',
            text: '选择文件'
        });
        uploadButton.onclick = () => this.fileInput.click();

        // 创建查看器容器
        this.viewerContainer = this.container.createDiv('viewer-container');
        this.viewerContainer.style.display = 'none';

        // 创建查看器头部
        const viewerHeader = this.viewerContainer.createDiv('viewer-header');
        viewerHeader.createEl('h2', { text: '多序列浏览' });
        
        // 创建同步选项
        this.createSyncOptions();

        // 创建多序列查看器区域
        this.multiViewer = this.viewerContainer.createDiv('multi-viewer');

        // 创建控制面板
        this.createControls();
    }

    async loadFile(file: TFile) {
        try {
            // 读取文件内容
            const arrayBuffer = await this.app.vault.readBinary(file);
            const blob = new Blob([arrayBuffer], { type: 'image/jpeg' });
            
            // 创建 File 对象
            const imageFile = new File([blob], file.name, { type: 'image/jpeg' });
            
            // 创建 URL
            const url = URL.createObjectURL(imageFile);
            
            // 创建帧对象
            const frame: SeriesFrame = {
                file: imageFile,
                name: file.name,
                url: url,
                frameNumber: 0,
                position: 0
            };
            
            // 创建序列数据
            const seriesName = this.detectSeriesFromFileName(file.name).name;
            this.seriesData[seriesName] = {
                name: seriesName,
                frames: [frame],
                sliceThickness: 5,
                sliceSpacing: 5,
                positions: [0]
            };
            
            // 显示查看器
            this.viewerContainer.style.display = 'block';
            
            // 创建序列查看器
            this.createSeriesViewers();
            
            // 显示第一帧
            this.showFrame(0);
            
            // 调整大小
            this.handleResize();
        } catch (error) {
            console.error('加载文件失败:', error);
        }
    }

    private addStyles() {
        const styleEl = document.createElement('style');
        styleEl.textContent = `
            .mr-viewer-container {
                padding: 20px;
                height: 100%;
                overflow: auto;
                background-color: var(--background-primary);
            }
            
            .upload-section {
                border: 2px dashed var(--background-modifier-border);
                padding: 30px;
                text-align: center;
                margin-bottom: 20px;
                border-radius: 5px;
                background-color: var(--background-secondary);
                transition: border-color 0.3s;
            }
            
            .upload-section:hover {
                border-color: var(--interactive-accent);
            }
            
            .upload-btn {
                background-color: var(--interactive-accent);
                color: var(--text-on-accent);
                padding: 10px 20px;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 16px;
                transition: background-color 0.3s;
            }
            
            .upload-btn:hover {
                background-color: var(--interactive-accent-hover);
            }
            
            .viewer-container {
                margin-top: 20px;
            }
            
            .viewer-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 15px;
            }
            
            .sync-options {
                display: flex;
                justify-content: center;
                gap: 15px;
                margin-bottom: 15px;
            }
            
            .sync-option {
                display: flex;
                align-items: center;
                gap: 5px;
            }
            
            .multi-viewer {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
                gap: 15px;
                margin-bottom: 15px;
            }
            
            .viewer-item {
                position: relative;
                border: 1px solid var(--background-modifier-border);
                border-radius: 5px;
                overflow: hidden;
                transition: border-color 0.2s;
            }
            
            .viewer-item.active {
                border-color: var(--interactive-accent);
                box-shadow: 0 0 0 2px var(--interactive-accent-hover);
            }
            
            .viewer-item.hover {
                border-color: var(--interactive-accent);
            }
            
            .viewer-title {
                background-color: var(--interactive-accent);
                color: var(--text-on-accent);
                padding: 8px;
                text-align: center;
                font-weight: bold;
            }
            
            .image-container {
                position: relative;
                width: 100%;
                height: 300px;
                background-color: var(--background-primary);
                overflow: hidden;
                cursor: pointer;
                touch-action: none;
            }
            
            .dicom-image {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                object-fit: contain;
                image-rendering: -webkit-optimize-contrast;
                image-rendering: crisp-edges;
                opacity: 0;
                transition: none;
                will-change: opacity, transform;
                backface-visibility: hidden;
                transform: translateZ(0);
                pointer-events: none;
            }
            
            .dicom-image.active {
                opacity: 1;
                z-index: 2;
            }
            
            .dicom-image.inactive {
                opacity: 0;
                z-index: 1;
            }
            
            .controls {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
                margin-bottom: 15px;
            }
            
            .control-group {
                flex: 1;
                min-width: 200px;
                background-color: var(--background-secondary);
                padding: 10px;
                border-radius: 5px;
            }
            
            .control-group h3 {
                margin-top: 0;
                margin-bottom: 10px;
                font-size: 16px;
                color: var(--text-normal);
            }
            
            .slider-container {
                margin-bottom: 10px;
            }
            
            .slider-container label {
                display: block;
                margin-bottom: 5px;
                font-weight: bold;
                color: var(--text-normal);
            }
            
            input[type="range"] {
                width: 100%;
            }
            
            .playback-controls {
                display: flex;
                gap: 10px;
                align-items: center;
                justify-content: center;
            }
            
            button {
                padding: 8px 15px;
                background-color: var(--interactive-accent);
                color: var(--text-on-accent);
                border: none;
                border-radius: 4px;
                cursor: pointer;
                transition: background-color 0.3s;
            }
            
            button:hover {
                background-color: var(--interactive-accent-hover);
            }
            
            button:disabled {
                background-color: var(--background-modifier-disabled);
                cursor: not-allowed;
            }
            
            .filename-display {
                background-color: var(--background-secondary);
                color: var(--text-normal);
                padding: 5px 10px;
                font-size: 12px;
                text-align: center;
                border-radius: 0 0 4px 4px;
                max-width: 100%;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            
            .active-series-indicator {
                position: absolute;
                top: 5px;
                right: 5px;
                background-color: var(--interactive-accent);
                color: var(--text-on-accent);
                padding: 3px 6px;
                border-radius: 3px;
                font-size: 12px;
                z-index: 4;
                display: none;
            }
            
            .viewer-item.active .active-series-indicator {
                display: block;
            }
            
            .mr-viewer-tooltip {
                position: absolute;
                bottom: 10px;
                left: 50%;
                transform: translateX(-50%);
                background-color: rgba(0, 0, 0, 0.7);
                color: white;
                padding: 5px 10px;
                border-radius: 4px;
                font-size: 12px;
                opacity: 0;
                transition: opacity 0.2s;
                pointer-events: none;
                z-index: 3;
            }
            
            .image-container:hover .mr-viewer-tooltip {
                opacity: 1;
            }
            
            .fullscreen-viewer {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background-color: rgba(0, 0, 0, 0.9);
                z-index: 1000;
                display: none;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                cursor: pointer;
            }
            
            .fullscreen-viewer.active {
                display: flex;
            }
            
            .fullscreen-image-container {
                position: relative;
                max-width: 95%;
                max-height: 90%;
                display: flex;
                flex-direction: column;
                align-items: center;
            }
            
            .fullscreen-image {
                max-width: 100%;
                max-height: calc(90vh - 40px);
                object-fit: contain;
            }
            
            .fullscreen-filename {
                color: white;
                padding: 10px;
                font-size: 14px;
                text-align: center;
                margin-top: 10px;
                background-color: rgba(0, 0, 0, 0.5);
                border-radius: 4px;
                max-width: 90%;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            
            .fullscreen-close {
                position: absolute;
                top: 20px;
                right: 20px;
                color: white;
                font-size: 24px;
                cursor: pointer;
                padding: 10px;
                background: rgba(0, 0, 0, 0.5);
                border-radius: 50%;
                width: 40px;
                height: 40px;
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 1001;
            }
            
            .fullscreen-close:hover {
                background: rgba(0, 0, 0, 0.8);
            }
        `;
        document.head.appendChild(styleEl);
    }

    private createSyncOptions() {
        const syncOptions = this.viewerContainer.createDiv('sync-options');
        
        // 帧同步选项
        const frameSync = syncOptions.createDiv('sync-option');
        const frameSyncRadio = frameSync.createEl('input', {
            type: 'radio',
            attr: {
                id: 'sync-frame',
                name: 'sync-mode',
                value: 'frame',
                checked: true
            }
        });
        frameSync.createEl('label', {
            text: '同步帧索引',
            attr: { for: 'sync-frame' }
        });

        // 位置同步选项
        const positionSync = syncOptions.createDiv('sync-option');
        const positionSyncRadio = positionSync.createEl('input', {
            type: 'radio',
            attr: {
                id: 'sync-position',
                name: 'sync-mode',
                value: 'position'
            }
        });
        positionSync.createEl('label', {
            text: '同步解剖位置',
            attr: { for: 'sync-position' }
        });

        // 启用同步选项
        const syncEnable = syncOptions.createDiv('sync-option');
        const syncEnableCheckbox = syncEnable.createEl('input', {
            type: 'checkbox',
            attr: {
                id: 'sync-series',
                checked: true
            }
        });
        syncEnable.createEl('label', {
            text: '启用同步',
            attr: { for: 'sync-series' }
        });

        // 绑定事件
        frameSyncRadio.addEventListener('change', () => {
            if (frameSyncRadio.checked) {
                this.syncMode = 'frame';
                if (this.syncEnabled) {
                    // 重置当前帧索引为所有序列中最小的帧索引
                    const minFrameIndex = Math.min(...Object.values(this.activeViewers).map(v => v.currentFrame));
                    this.currentFrameIndex = minFrameIndex;
                    this.showFrame(minFrameIndex);
                }
            }
        });

        positionSyncRadio.addEventListener('change', () => {
            if (positionSyncRadio.checked) {
                this.syncMode = 'position';
                if (this.syncEnabled) {
                    // 重置当前位置为所有序列中最小的位置
                    const minPosition = Math.min(...Object.values(this.activeViewers).map(v => v.currentPosition));
                    this.currentPosition = minPosition;
                    this.showFrame(this.currentFrameIndex);
                }
            }
        });

        syncEnableCheckbox.addEventListener('change', () => {
            this.syncEnabled = syncEnableCheckbox.checked;
            if (this.syncEnabled) {
                this.activeSeries = null;
                this.updateActiveSeriesIndicator();
                // 重置为所有序列中最小的帧索引
                const minFrameIndex = Math.min(...Object.values(this.activeViewers).map(v => v.currentFrame));
                this.currentFrameIndex = minFrameIndex;
                this.showFrame(minFrameIndex);
            }
        });
    }

    private bindEventListeners() {
        // 文件选择事件
        this.fileInput.addEventListener('change', this.handleFileSelect.bind(this));

        // 键盘事件
        document.addEventListener('keydown', (event: KeyboardEvent) => {
            if (!this.containerEl.hasClass('is-focused')) return;

            switch (event.key) {
                case 'ArrowLeft':
                    this.showPreviousFrame(true, this.syncEnabled ? null : this.activeSeries);
                    event.preventDefault();
                    break;
                case 'ArrowRight':
                    this.showNextFrame(true, this.syncEnabled ? null : this.activeSeries);
                    event.preventDefault();
                    break;
                case 'Space':
                    const playPauseButton = this.containerEl.querySelector('.playback-controls button:nth-child(2)') as HTMLButtonElement;
                    if (playPauseButton) {
                        this.togglePlayback(playPauseButton);
                    }
                    event.preventDefault();
                    break;
            }
        });

        // 窗口大小改变事件
        window.addEventListener('resize', this.handleResize.bind(this));
    }

    private handleResize() {
        // 调整图像容器大小
        const containers = this.containerEl.querySelectorAll('.image-container');
        containers.forEach((container: HTMLElement) => {
            const width = container.offsetWidth;
            container.style.height = `${width * 0.75}px`; // 保持4:3的宽高比
        });
    }

    private async handleFileSelect(event: Event) {
        const target = event.target as HTMLInputElement;
        const files = target.files;
        if (!files || files.length === 0) return;

        // 清空现有数据
        this.seriesData = {};
        this.activeViewers = {};
        this.multiViewer.empty();
        this.imageCache = {};
        this.activeSeries = null;

        // 按序列分组
        const seriesGroups: { [key: string]: File[] } = {};
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fileName = file.name;
            const seriesInfo = this.detectSeriesFromFileName(fileName);
            
            if (!seriesGroups[seriesInfo.name]) {
                seriesGroups[seriesInfo.name] = [];
            }
            seriesGroups[seriesInfo.name].push(file);
        }

        // 处理每个序列组
        for (const seriesName in seriesGroups) {
            await this.processSeriesFiles(seriesName, seriesGroups[seriesName]);
        }

        // 保存序列数据
        await this.saveSeriesData();

        // 显示查看器
        this.viewerContainer.style.display = 'block';
        
        // 创建序列查看器
        this.createSeriesViewers();
        
        // 显示第一帧
        this.showFrame(0);

        // 调整大小
        this.handleResize();
    }

    private detectSeriesFromFileName(fileName: string): { name: string; number: number } {
        if (fileName.match(/T1|T1_|_T1/i)) {
            return { name: "T1加权像 (T1WI)", number: 1 };
        } else if (fileName.match(/T2|T2_|_T2/i)) {
            return { name: "T2加权像 (T2WI)", number: 2 };
        } else if (fileName.match(/FLAIR/i)) {
            return { name: "FLAIR序列", number: 3 };
        } else if (fileName.match(/DWI/i)) {
            return { name: "弥散加权像 (DWI)", number: 4 };
        } else if (fileName.match(/SWI/i)) {
            return { name: "磁敏感加权成像 (SWI)", number: 5 };
        } else if (fileName.match(/ADC/i)) {
            return { name: "ADC图", number: 6 };
        } else if (fileName.match(/(SER|Seq|Series)[_\s]*(\d+)/i)) {
            const num = parseInt(RegExp.$2);
            return { name: `序列 ${num}`, number: num };
        }
        return { name: "未知序列", number: 999 };
    }

    private async processSeriesFiles(seriesName: string, files: File[]) {
        // 提取帧号并排序
        const framesWithNumbers = files.map(file => {
            const match = file.name.match(/(\d+)(?!.*\d)/);
            const frameNumber = match ? parseInt(match[1]) : 0;
            return { file, frameNumber };
        });

        framesWithNumbers.sort((a, b) => a.frameNumber - b.frameNumber);

        const frames: SeriesFrame[] = [];
        const positions: number[] = [];

        // 预加载所有图像
        const preloadPromises = framesWithNumbers.map(async ({ file, frameNumber }) => {
            const url = URL.createObjectURL(file);
            const frame: SeriesFrame = {
                file,
                name: file.name,
                url,
                frameNumber: frameNumber,
                position: frames.length * 5
            };
            frames.push(frame);
            positions.push(frame.position);
            
            return this.preloadImage(url);
        });

        await Promise.all(preloadPromises);

        this.seriesData[seriesName] = {
            name: seriesName,
            frames,
            sliceThickness: 5,
            sliceSpacing: 5,
            positions
        };

        // 创建位置映射
        this.createPositionMap();
    }

    private createPositionMap() {
        // 收集所有序列的所有位置
        const allPositions: number[] = [];
        for (const seriesName in this.seriesData) {
            allPositions.push(...this.seriesData[seriesName].positions);
        }
        
        // 去重并排序
        const uniquePositions = [...new Set(allPositions)].sort((a, b) => a - b);
        
        // 创建位置到索引的映射
        this.positionMap.positions = uniquePositions;
        this.positionMap.indexMap = {};
        
        // 为每个序列创建位置到帧索引的映射
        for (const seriesName in this.seriesData) {
            const series = this.seriesData[seriesName];
            this.positionMap[seriesName] = {};
            
            // 创建从位置到帧索引的映射
            for (let i = 0; i < series.positions.length; i++) {
                this.positionMap[seriesName][series.positions[i]] = i;
            }
        }
    }

    private preloadImage(url: string): Promise<void> {
        return new Promise((resolve) => {
            if (this.imageCache[url] && this.imageCache[url].complete) {
                resolve();
                return;
            }

            const img = new Image();
            img.decoding = 'async';
            img.loading = 'eager';
            
            img.onload = () => {
                img.decode().then(() => {
                    this.imageCache[url] = img;
                    resolve();
                }).catch(() => {
                    this.imageCache[url] = img;
                    resolve();
                });
            };
            
            img.onerror = () => resolve();
            img.src = url;
        });
    }

    private createSeriesViewers() {
        // 清空现有查看器
        this.multiViewer.empty();

        // 获取所有序列并按序号排序
        const seriesList = Object.entries(this.seriesData)
            .sort(([, a], [, b]) => {
                // 从序列名称中提取数字
                const numA = parseInt(a.name.match(/\d+/)?.[0] || '999');
                const numB = parseInt(b.name.match(/\d+/)?.[0] || '999');
                return numA - numB;
            });

        // 创建查看器网格
        this.multiViewer.style.gridTemplateColumns = `repeat(${Math.min(2, seriesList.length)}, 1fr)`;

        // 为每个序列创建查看器
        for (const [seriesName, series] of seriesList) {
            const viewerItem = this.multiViewer.createDiv('viewer-item');
            const title = viewerItem.createDiv('viewer-title');
            title.textContent = `${seriesName} (${series.frames.length}帧)`;

            const container = viewerItem.createDiv('image-container');
            const filenameDisplay = viewerItem.createDiv('filename-display');
            const activeIndicator = viewerItem.createDiv('active-indicator');

            // 创建两个图像元素用于双缓冲
            const images: HTMLImageElement[] = [
                container.createEl('img', { cls: 'dicom-image active' }),
                container.createEl('img', { cls: 'dicom-image inactive' })
            ];

            // 初始化第一帧图像
            if (series.frames.length > 0) {
                const firstFrame = series.frames[0];
                images[0].src = firstFrame.url;
                images[0].style.opacity = '1';
                filenameDisplay.textContent = firstFrame.name;
            }

            // 创建全屏显示容器
            const fullscreenContainer = this.containerEl.createDiv('fullscreen-viewer');
            const fullscreenImageContainer = fullscreenContainer.createDiv('fullscreen-image-container');
            const fullscreenImage = fullscreenImageContainer.createEl('img', { cls: 'fullscreen-image' });
            const fullscreenFilename = fullscreenImageContainer.createDiv('fullscreen-filename');
            const closeButton = fullscreenContainer.createDiv('fullscreen-close');
            closeButton.textContent = '×';

            // 将全屏容器添加到 viewer 数据中
            this.activeViewers[seriesName] = {
                element: viewerItem,
                container,
                images,
                currentActive: 0,
                currentFrame: 0,
                currentPosition: 0,
                filenameDisplay,
                activeIndicator,
                fullscreenContainer
            };

            // 绑定双击事件
            container.addEventListener('dblclick', () => this.handleFullscreen(seriesName));
            
            // 绑定关闭按钮事件
            closeButton.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closeFullscreen(seriesName);
            });
            
            // 绑定全屏容器点击事件
            fullscreenContainer.addEventListener('click', () => {
                this.closeFullscreen(seriesName);
            });

            // 绑定点击事件
            container.addEventListener('click', () => this.handleSeriesSelect(seriesName));
            container.addEventListener('wheel', (e) => this.handleWheelScroll(e, seriesName));
        }

        // 显示第一帧
        this.showFrame(0, false);
    }

    private async showFrame(frameIndex: number, allowLoop = false, targetSeries: string | null = null) {
        const maxFrames = this.positionMap.positions.length;
        
        // 处理循环播放
        if (allowLoop) {
            if (frameIndex < 0) {
                frameIndex = maxFrames - 1;
            } else if (frameIndex >= maxFrames) {
                frameIndex = 0;
            }
        } else {
            // 非循环模式下限制在有效范围内
            frameIndex = Math.max(0, Math.min(frameIndex, maxFrames - 1));
        }
        
        this.currentFrameIndex = frameIndex;
        this.currentPosition = this.positionMap.positions[frameIndex];
        
        // 更新帧导航滑块
        const frameSlider = this.containerEl.querySelector('#frame-slider') as HTMLInputElement;
        if (frameSlider) {
            frameSlider.max = maxFrames.toString();
            frameSlider.value = (frameIndex + 1).toString();
        }

        const promises: Promise<void>[] = [];

        if (this.syncEnabled) {
            // 同步模式下更新所有序列
            for (const seriesName in this.activeViewers) {
                promises.push(this.updateSeriesFrame(seriesName, frameIndex));
            }
        } else if (targetSeries) {
            // 非同步模式下只更新目标序列
            promises.push(this.updateSeriesFrame(targetSeries, frameIndex, true));
        }

        await Promise.all(promises);
    }

    private async updateSeriesFrame(seriesName: string, frameIndex: number, forceUpdate = false): Promise<void> {
        return new Promise<void>((resolve) => {
            const viewer = this.activeViewers[seriesName];
            const series = this.seriesData[seriesName];
            
            if (!viewer || !series) {
                resolve();
                return;
            }
            
            // 根据同步模式决定显示哪一帧
            let displayFrameIndex;
            if (this.syncEnabled && this.syncMode === 'position') {
                // 同步解剖位置 - 找到最接近的层面
                const position = this.positionMap.positions[frameIndex];
                displayFrameIndex = this.positionMap[seriesName][position] || 0;
            } else if (this.syncEnabled) {
                // 同步帧索引 - 确保不超过序列长度
                displayFrameIndex = Math.min(frameIndex, series.frames.length - 1);
            } else {
                // 非同步模式 - 保持当前帧或强制更新
                if (forceUpdate) {
                    displayFrameIndex = Math.min(frameIndex, series.frames.length - 1);
                } else {
                    resolve();
                    return;
                }
            }
            
            // 如果帧没有变化且不是强制更新，则跳过
            if (!forceUpdate && viewer.currentFrame === displayFrameIndex) {
                resolve();
                return;
            }
            
            viewer.currentFrame = displayFrameIndex;
            viewer.currentPosition = series.positions[displayFrameIndex] || 0;
            
            const frameObj = series.frames[displayFrameIndex];
            const frameUrl = frameObj.url;
            const nextActive = (viewer.currentActive + 1) % 2;
            const nextImage = viewer.images[nextActive];
            const currentImage = viewer.images[viewer.currentActive];
            
            // 更新文件名显示
            viewer.filenameDisplay.textContent = frameObj.name;
            
            // 更新工具提示
            const tooltip = viewer.container.querySelector('.mr-viewer-tooltip');
            if (tooltip) {
                tooltip.textContent = `帧: ${displayFrameIndex + 1}/${series.frames.length} | 位置: ${viewer.currentPosition.toFixed(1)}mm`;
            }
            
            this.switchImage(nextImage, currentImage, frameUrl, viewer, nextActive, resolve);
        });
    }

    private switchImage(
        nextImage: HTMLImageElement,
        currentImage: HTMLImageElement,
        frameUrl: string,
        viewer: ViewerData,
        nextActive: number,
        resolve: () => void
    ) {
        if (this.imageCache[frameUrl] && this.imageCache[frameUrl].complete) {
            nextImage.src = frameUrl;
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    nextImage.style.opacity = '1';
                    currentImage.style.opacity = '0';
                    
                    setTimeout(() => {
                        currentImage.classList.remove('active');
                        currentImage.classList.add('inactive');
                        nextImage.classList.remove('inactive');
                        nextImage.classList.add('active');
                        viewer.currentActive = nextActive;
                        resolve();
                    }, 0);
                });
            });
        } else {
            this.preloadImage(frameUrl).then(() => {
                this.switchImage(nextImage, currentImage, frameUrl, viewer, nextActive, resolve);
            });
        }
    }

    private showPreviousFrame(allowLoop = false, targetSeries: string | null = null) {
        if (this.syncEnabled) {
            // 同步模式下，更新所有序列
            const maxFrames = this.positionMap.positions.length;
            let newIndex = this.currentFrameIndex - 1;
            
            if (allowLoop) {
                if (newIndex < 0) {
                    newIndex = maxFrames - 1;
                }
            } else {
                newIndex = Math.max(0, newIndex);
            }
            
            this.showFrame(newIndex, allowLoop);
        } else if (targetSeries) {
            // 非同步模式下，只更新目标序列
            const viewer = this.activeViewers[targetSeries];
            const series = this.seriesData[targetSeries];
            if (viewer && series) {
                let newIndex = viewer.currentFrame - 1;
                
                if (allowLoop) {
                    if (newIndex < 0) {
                        newIndex = series.frames.length - 1;
                    }
                } else {
                    newIndex = Math.max(0, newIndex);
                }
                
                // 更新当前帧索引和位置
                this.currentFrameIndex = newIndex;
                this.currentPosition = series.positions[newIndex];
                
                // 更新帧导航滑块
                const frameSlider = this.containerEl.querySelector('#frame-slider') as HTMLInputElement;
                if (frameSlider) {
                    frameSlider.max = series.frames.length.toString();
                    frameSlider.value = (newIndex + 1).toString();
                }
                
                // 更新序列帧
                this.updateSeriesFrame(targetSeries, newIndex, true);
            }
        }
    }

    private showNextFrame(allowLoop = false, targetSeries: string | null = null) {
        if (this.syncEnabled) {
            // 同步模式下，更新所有序列
            const maxFrames = this.positionMap.positions.length;
            let newIndex = this.currentFrameIndex + 1;
            
            if (allowLoop) {
                if (newIndex >= maxFrames) {
                    newIndex = 0;
                }
            } else {
                newIndex = Math.min(maxFrames - 1, newIndex);
            }
            
            this.showFrame(newIndex, allowLoop);
        } else if (targetSeries) {
            // 非同步模式下，只更新目标序列
            const viewer = this.activeViewers[targetSeries];
            const series = this.seriesData[targetSeries];
            if (viewer && series) {
                let newIndex = viewer.currentFrame + 1;
                
                if (allowLoop) {
                    if (newIndex >= series.frames.length) {
                        newIndex = 0;
                    }
                } else {
                    newIndex = Math.min(series.frames.length - 1, newIndex);
                }
                
                // 更新当前帧索引和位置
                this.currentFrameIndex = newIndex;
                this.currentPosition = series.positions[newIndex];
                
                // 更新帧导航滑块
                const frameSlider = this.containerEl.querySelector('#frame-slider') as HTMLInputElement;
                if (frameSlider) {
                    frameSlider.max = series.frames.length.toString();
                    frameSlider.value = (newIndex + 1).toString();
                }
                
                // 更新序列帧
                this.updateSeriesFrame(targetSeries, newIndex, true);
            }
        }
    }

    private updateActiveSeriesIndicator() {
        for (const seriesName in this.activeViewers) {
            const viewer = this.activeViewers[seriesName];
            if (seriesName === this.activeSeries) {
                viewer.element.classList.add('active');
                viewer.activeIndicator.style.display = 'block';
                viewer.activeIndicator.textContent = '当前序列';
            } else {
                viewer.element.classList.remove('active');
                viewer.activeIndicator.style.display = 'none';
            }
        }
    }

    private handleSeriesSelect(seriesName: string) {
        if (!this.syncEnabled) {
            this.activeSeries = seriesName;
            this.updateActiveSeriesIndicator();
            
            // 更新当前帧索引为选中序列的当前帧
            const viewer = this.activeViewers[seriesName];
            if (viewer) {
                this.currentFrameIndex = viewer.currentFrame;
                this.currentPosition = viewer.currentPosition;
                
                // 更新帧导航滑块
                const frameSlider = this.containerEl.querySelector('#frame-slider') as HTMLInputElement;
                if (frameSlider) {
                    const series = this.seriesData[seriesName];
                    frameSlider.max = series.frames.length.toString();
                    frameSlider.value = (viewer.currentFrame + 1).toString();
                }
            }
        }
    }

    private handleWheelScroll(event: WheelEvent, seriesName: string) {
        event.preventDefault();
        
        const now = Date.now();
        if (now - this.lastWheelTime < 30) return;
        this.lastWheelTime = now;
        
        this.wheelDelta += event.deltaY;
        
        if (Math.abs(this.wheelDelta) > 30) {
            if (this.wheelDelta > 0) {
                this.showNextFrame(true, seriesName);
            } else {
                this.showPreviousFrame(true, seriesName);
            }
            this.wheelDelta = 0;
        }
    }

    private togglePlayback(button: HTMLButtonElement) {
        this.isPlaying = !this.isPlaying;
        
        if (this.isPlaying) {
            button.textContent = '暂停';
            this.startPlayback();
        } else {
            button.textContent = '播放';
            this.stopPlayback();
        }
    }

    private startPlayback() {
        if (this.playInterval) {
            cancelAnimationFrame(this.playInterval);
        }
        
        const maxFrames = this.positionMap.positions.length;
        
        if (maxFrames === 0) {
            this.stopPlayback();
            return;
        }
        
        const delay = 1000 / this.playbackSpeed;
        let lastTime = performance.now();
        
        const framePlayback = (time: number) => {
            if (!this.isPlaying) return;
            
            const elapsed = time - lastTime;
            if (elapsed >= delay) {
                lastTime = time - (elapsed % delay);
                
                if (this.syncEnabled) {
                    // 同步模式下，更新所有序列
                    if (this.currentFrameIndex >= maxFrames - 1) {
                        this.showFrame(0);
                    } else {
                        this.showNextFrame();
                    }
                } else if (this.activeSeries) {
                    // 非同步模式下，只更新激活的序列
                    const viewer = this.activeViewers[this.activeSeries];
                    if (viewer.currentFrame >= maxFrames - 1) {
                        this.showFrame(0, false, this.activeSeries);
                    } else {
                        this.showNextFrame(false, this.activeSeries);
                    }
                }
            }
            
            this.playInterval = requestAnimationFrame(framePlayback);
        };
        
        this.playInterval = requestAnimationFrame(framePlayback);
    }

    private stopPlayback() {
        if (this.playInterval) {
            cancelAnimationFrame(this.playInterval);
            this.playInterval = null;
        }
    }

    private createControls() {
        const controls = this.viewerContainer.createDiv('controls');
        
        // 窗宽窗位控制
        const windowControl = controls.createDiv('control-group');
        windowControl.createEl('h3', { text: '窗宽窗位调整' });
        
        const windowLevelContainer = windowControl.createDiv('slider-container');
        windowLevelContainer.createEl('label', { text: '窗位 (Window Level)' });
        const windowLevelSlider = windowLevelContainer.createEl('input', {
            type: 'range',
            attr: {
                id: 'window-level',
                min: '0',
                max: '255',
                value: '128'
            }
        });
        windowLevelContainer.createEl('span', { text: '值: 128' });
        
        const windowWidthContainer = windowControl.createDiv('slider-container');
        windowWidthContainer.createEl('label', { text: '窗宽 (Window Width)' });
        const windowWidthSlider = windowWidthContainer.createEl('input', {
            type: 'range',
            attr: {
                id: 'window-width',
                min: '1',
                max: '255',
                value: '255'
            }
        });
        windowWidthContainer.createEl('span', { text: '值: 255' });
        
        // 添加窗宽窗位重置按钮
        windowControl.createEl('button', { text: '重置窗宽窗位' }).onclick = () => this.resetWindowSettings();
        
        // 图像调整控制
        const imageControl = controls.createDiv('control-group');
        imageControl.createEl('h3', { text: '图像调整' });
        
        const brightnessContainer = imageControl.createDiv('slider-container');
        brightnessContainer.createEl('label', { text: '亮度' });
        const brightnessSlider = brightnessContainer.createEl('input', {
            type: 'range',
            attr: {
                id: 'brightness',
                min: '0',
                max: '200',
                value: '100'
            }
        });
        brightnessContainer.createEl('span', { text: '值: 100%' });
        
        const contrastContainer = imageControl.createDiv('slider-container');
        contrastContainer.createEl('label', { text: '对比度' });
        const contrastSlider = contrastContainer.createEl('input', {
            type: 'range',
            attr: {
                id: 'contrast',
                min: '0',
                max: '200',
                value: '100'
            }
        });
        contrastContainer.createEl('span', { text: '值: 100%' });
        
        // 添加图像调整重置按钮
        imageControl.createEl('button', { text: '重置图像调整' }).onclick = () => this.resetImageAdjustments();
        
        // 播放控制
        const playbackControl = controls.createDiv('control-group');
        playbackControl.createEl('h3', { text: '序列播放' });
        
        const playbackButtons = playbackControl.createDiv('playback-controls');
        playbackButtons.createEl('button', { text: '上一帧' }).onclick = () => this.showPreviousFrame(true, this.syncEnabled ? null : this.activeSeries);
        const playPauseBtn = playbackButtons.createEl('button', { text: '播放' });
        playPauseBtn.onclick = () => this.togglePlayback(playPauseBtn);
        playbackButtons.createEl('button', { text: '下一帧' }).onclick = () => this.showNextFrame(true, this.syncEnabled ? null : this.activeSeries);
        
        // 帧导航滑块
        const frameSliderContainer = playbackControl.createDiv('slider-container');
        frameSliderContainer.createEl('label', { text: '帧导航' });
        const frameSlider = frameSliderContainer.createEl('input', {
            type: 'range',
            attr: {
                id: 'frame-slider',
                min: '1',
                value: '1',
                step: '1'
            }
        });
        
        // 播放速度控制
        const speedContainer = playbackControl.createDiv('slider-container');
        speedContainer.createEl('label', { text: '播放速度' });
        const speedSlider = speedContainer.createEl('input', {
            type: 'range',
            attr: {
                id: 'playback-speed',
                min: '1',
                max: '10',
                value: '5'
            }
        });
        speedContainer.createEl('span', { text: '速度: 5x' });
        
        // 绑定事件
        windowLevelSlider.addEventListener('input', () => {
            const value = windowLevelSlider.value;
            const span = windowLevelContainer.querySelector('span');
            if (span) span.textContent = `值: ${value}`;
            this.updateWindowSettings();
        });
        
        windowWidthSlider.addEventListener('input', () => {
            const value = windowWidthSlider.value;
            const span = windowWidthContainer.querySelector('span');
            if (span) span.textContent = `值: ${value}`;
            this.updateWindowSettings();
        });
        
        brightnessSlider.addEventListener('input', () => {
            const value = brightnessSlider.value;
            const span = brightnessContainer.querySelector('span');
            if (span) span.textContent = `值: ${value}%`;
            this.updateImageAdjustments();
        });
        
        contrastSlider.addEventListener('input', () => {
            const value = contrastSlider.value;
            const span = contrastContainer.querySelector('span');
            if (span) span.textContent = `值: ${value}%`;
            this.updateImageAdjustments();
        });
        
        frameSlider.addEventListener('input', () => {
            const frameIndex = parseInt(frameSlider.value) - 1;
            this.showFrame(frameIndex);
        });
        
        speedSlider.addEventListener('input', () => {
            const value = speedSlider.value;
            const span = speedContainer.querySelector('span');
            if (span) span.textContent = `速度: ${value}x`;
            this.playbackSpeed = parseInt(value);
            if (this.isPlaying) {
                this.stopPlayback();
                this.startPlayback();
            }
        });
    }

    private updateWindowSettings() {
        const windowLevelSlider = this.containerEl.querySelector('#window-level') as HTMLInputElement;
        const windowWidthSlider = this.containerEl.querySelector('#window-width') as HTMLInputElement;
        const brightnessSlider = this.containerEl.querySelector('#brightness') as HTMLInputElement;
        const contrastSlider = this.containerEl.querySelector('#contrast') as HTMLInputElement;
        
        if (windowLevelSlider && windowWidthSlider && brightnessSlider && contrastSlider) {
            const windowLevel = parseInt(windowLevelSlider.value);
            const windowWidth = parseInt(windowWidthSlider.value);
            const brightness = parseInt(brightnessSlider.value);
            const contrast = parseInt(contrastSlider.value);
            
            if (this.syncEnabled) {
                // 同步模式下更新所有序列
                for (const seriesName in this.activeViewers) {
                    const viewer = this.activeViewers[seriesName];
                    viewer.images.forEach(img => {
                        img.style.filter = `
                            brightness(${windowLevel / 255 * 100}%) 
                            contrast(${windowWidth / 255 * 100}%)
                            brightness(${brightness}%) 
                            contrast(${contrast}%)
                        `;
                    });
                }
            } else if (this.activeSeries) {
                // 非同步模式下只更新选中的序列
                const viewer = this.activeViewers[this.activeSeries];
                if (viewer) {
                    viewer.images.forEach(img => {
                        img.style.filter = `
                            brightness(${windowLevel / 255 * 100}%) 
                            contrast(${windowWidth / 255 * 100}%)
                            brightness(${brightness}%) 
                            contrast(${contrast}%)
                        `;
                    });
                }
            }
        }
    }

    private updateImageAdjustments() {
        this.updateWindowSettings();
    }

    private resetWindowSettings() {
        const windowLevelSlider = this.containerEl.querySelector('#window-level') as HTMLInputElement;
        const windowWidthSlider = this.containerEl.querySelector('#window-width') as HTMLInputElement;
        
        if (windowLevelSlider && windowWidthSlider) {
            windowLevelSlider.value = '128';
            windowWidthSlider.value = '255';
            this.updateWindowSettings();
        }
    }

    private resetImageAdjustments() {
        const brightnessSlider = this.containerEl.querySelector('#brightness') as HTMLInputElement;
        const contrastSlider = this.containerEl.querySelector('#contrast') as HTMLInputElement;
        
        if (brightnessSlider && contrastSlider) {
            brightnessSlider.value = '100';
            contrastSlider.value = '100';
            this.updateImageAdjustments();
        }
    }

    private handleFullscreen(seriesName: string) {
        const viewer = this.activeViewers[seriesName];
        const series = this.seriesData[seriesName];
        
        if (!viewer || !series || !viewer.fullscreenContainer) return;
        
        const currentFrame = series.frames[viewer.currentFrame];
        if (!currentFrame) return;
        
        // 更新全屏图像和文件名
        const fullscreenImage = viewer.fullscreenContainer.querySelector('.fullscreen-image') as HTMLImageElement;
        const fullscreenFilename = viewer.fullscreenContainer.querySelector('.fullscreen-filename') as HTMLElement;
        
        if (fullscreenImage) {
            fullscreenImage.src = currentFrame.url;
        }
        if (fullscreenFilename) {
            fullscreenFilename.textContent = currentFrame.name;
        }
        
        // 显示全屏容器
        viewer.fullscreenContainer.classList.add('active');
        
        // 禁用滚动
        document.body.style.overflow = 'hidden';
    }

    private closeFullscreen(seriesName: string) {
        const viewer = this.activeViewers[seriesName];
        if (!viewer || !viewer.fullscreenContainer) return;
        
        // 隐藏全屏容器
        viewer.fullscreenContainer.classList.remove('active');
        
        // 恢复滚动
        document.body.style.overflow = '';
    }

    private async saveSeriesData() {
        const savedData: { [key: string]: any } = {};
        
        for (const seriesName in this.seriesData) {
            const series = this.seriesData[seriesName];
            const frames = await Promise.all(series.frames.map(async (frame) => {
                const arrayBuffer = await frame.file.arrayBuffer();
                const base64Data = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
                return {
                    name: frame.name,
                    frameNumber: frame.frameNumber,
                    position: frame.position,
                    data: base64Data
                };
            }));

            savedData[seriesName] = {
                name: series.name,
                frames,
                sliceThickness: series.sliceThickness,
                sliceSpacing: series.sliceSpacing,
                positions: series.positions
            };
        }

        this.plugin.settings.savedSeriesData = savedData;
        await this.plugin.saveSettings();
    }

    private async loadSavedSeriesData() {
        const savedData = this.plugin.settings.savedSeriesData;
        if (!savedData || Object.keys(savedData).length === 0) return;

        // 清理现有数据
        this.clearExistingData();

        // 首先创建所有序列和帧的基本结构
        for (const seriesName in savedData) {
            const series = savedData[seriesName];
            const frames: SeriesFrame[] = [];

            for (const frame of series.frames) {
                try {
                    const binaryString = atob(frame.data);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    const blob = new Blob([bytes], { type: 'image/jpeg' });
                    const file = new File([blob], frame.name, { type: 'image/jpeg' });
                    const url = URL.createObjectURL(blob);

                    frames.push({
                        file,
                        name: frame.name,
                        url,
                        frameNumber: frame.frameNumber,
                        position: frame.position
                    });

                    // 创建新的图像对象并预加载
                    const img = new Image();
                    img.decoding = 'async';
                    img.loading = 'eager';
                    img.src = url;
                    this.imageCache[url] = img;

                } catch (error) {
                    console.error('Error loading frame:', error);
                    continue;
                }
            }

            if (frames.length > 0) {
                this.seriesData[seriesName] = {
                    name: series.name,
                    frames,
                    sliceThickness: series.sliceThickness,
                    sliceSpacing: series.sliceSpacing,
                    positions: series.positions
                };
            }
        }

        // 等待所有图像加载完成
        const loadPromises = Object.values(this.imageCache).map(img => {
            return new Promise<void>((resolve) => {
                if (img.complete) {
                    img.decode().then(() => resolve()).catch(() => resolve());
                } else {
                    img.onload = () => {
                        img.decode().then(() => resolve()).catch(() => resolve());
                    };
                    img.onerror = () => resolve();
                }
            });
        });

        try {
            await Promise.all(loadPromises);
        } catch (error) {
            console.error('Error loading images:', error);
        }

        // 创建位置映射
        this.createPositionMap();

        // 显示查看器
        this.viewerContainer.style.display = 'block';
        
        // 创建序列查看器
        this.createSeriesViewers();
        
        // 显示第一帧
        this.showFrame(0);

        // 调整大小
        this.handleResize();
    }

    clearView() {
        // 清理现有数据
        this.clearExistingData();

        // 隐藏查看器容器
        if (this.viewerContainer) {
            this.viewerContainer.style.display = 'none';
        }

        // 重置文件输入
        if (this.fileInput) {
            this.fileInput.value = '';
        }

        // 重置视图创建状态
        this.isViewCreated = false;
    }

    private clearExistingData() {
        // 清理 URL 对象和图像缓存
        for (const seriesName in this.seriesData) {
            const series = this.seriesData[seriesName];
            for (const frame of series.frames) {
                URL.revokeObjectURL(frame.url);
            }
        }

        // 清空数据结构
        this.seriesData = {};
        this.activeViewers = {};
        this.imageCache = {};
        this.activeSeries = null;
        this.currentFrameIndex = 0;
        this.currentPosition = 0;
        this.isPlaying = false;
        this.playInterval = null;
        this.syncEnabled = true;
        this.syncMode = 'frame';
        this.lastWheelTime = 0;
        this.wheelDelta = 0;
        this.positionMap = {
            positions: [],
            indexMap: {}
        };

        // 清空视图
        if (this.multiViewer) {
            this.multiViewer.empty();
        }
    }
} 