import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	Platform,
} from "obsidian";

type TrayIconColor = "auto" | "white" | "black";

interface HeadlessModeSettings {
	/** Launch Obsidian straight into headless mode. */
	startHeadless: boolean;
	/** Hide the Dock icon while headless (macOS only). */
	hideDockIcon: boolean;
	/**
	 * Menu bar icon color. "auto" lets macOS tint a template image (the
	 * historical behavior); "white"/"black" force an explicit fill that
	 * ignores menu bar appearance.
	 */
	trayIconColor: TrayIconColor;
}

const DEFAULT_SETTINGS: HeadlessModeSettings = {
	startHeadless: false,
	hideDockIcon: true,
	trayIconColor: "white",
};

// Survives plugin reloads so we never leak a second tray icon.
const TRAY_GLOBAL = "__headlessModeTray";

/**
 * Obsidian's renderer exposes Electron's remote module. Newer builds route it
 * through @electron/remote, older ones through electron.remote — try both.
 */
function getElectronRemote(): any {
	const req = (window as any).require;
	if (!req) return null;
	try {
		const remote = req("electron")?.remote;
		if (remote) return remote;
	} catch {
		/* fall through */
	}
	try {
		return req("@electron/remote");
	} catch {
		return null;
	}
}

/**
 * Draw the tray icon at runtime on a canvas so the plugin ships no binary
 * assets. Color "auto" produces a macOS template image (pure black + alpha,
 * tinted by the OS); "white"/"black" produce an explicit fill.
 */
function createTrayIcon(remote: any, color: TrayIconColor): any {
	const fill = color === "black" ? "#000000" : "#ffffff";
	const image = remote.nativeImage.createEmpty();
	for (const scale of [1, 2]) {
		const size = 16 * scale;
		const canvas = document.createElement("canvas");
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext("2d")!;
		const s = scale;

		// Gem silhouette: a kite-shaped crystal.
		ctx.fillStyle = color === "auto" ? "#000000" : fill;
		ctx.beginPath();
		ctx.moveTo(8 * s, 1 * s);
		ctx.lineTo(13.5 * s, 5.5 * s);
		ctx.lineTo(8 * s, 15 * s);
		ctx.lineTo(2.5 * s, 5.5 * s);
		ctx.closePath();
		ctx.fill();

		// Carve facet lines out of the fill via destination-out so they read
		// as transparent regardless of the fill color.
		ctx.globalCompositeOperation = "destination-out";
		ctx.lineWidth = 1 * s;
		ctx.beginPath();
		ctx.moveTo(2.5 * s, 5.5 * s);
		ctx.lineTo(8 * s, 7.5 * s);
		ctx.lineTo(13.5 * s, 5.5 * s);
		ctx.stroke();
		ctx.beginPath();
		ctx.moveTo(8 * s, 7.5 * s);
		ctx.lineTo(8 * s, 15 * s);
		ctx.stroke();

		image.addRepresentation({
			scaleFactor: scale,
			dataURL: canvas.toDataURL("image/png"),
		});
	}
	if (color === "auto") image.setTemplateImage(true);
	return image;
}

export default class HeadlessModePlugin extends Plugin {
	settings: HeadlessModeSettings;
	/** Runtime-only on purpose: a restart never traps the user in a hidden app
	 *  unless they explicitly opted into "start headless". */
	headless = false;
	private remote: any = null;
	private tray: any = null;

	async onload() {
		await this.loadSettings();
		if (!Platform.isDesktopApp) return;

		this.remote = getElectronRemote();
		if (!this.remote) {
			console.error("Headless Mode: Electron remote API unavailable; plugin disabled.");
			return;
		}

		this.createTray();

		this.addCommand({
			id: "toggle",
			name: "Toggle headless mode",
			callback: () => this.setHeadless(!this.headless),
		});
		this.addCommand({
			id: "enter",
			name: "Go headless (hide window and Dock icon)",
			callback: () => this.setHeadless(true),
		});

		this.addSettingTab(new HeadlessModeSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			if (this.settings.startHeadless) this.setHeadless(true);
		});
	}

	onunload() {
		// Never strand the user: restore window + Dock before going away.
		if (this.headless) this.applyHeadless(false);
		this.destroyTray();
	}

	setHeadless(on: boolean) {
		if (on === this.headless) return;
		this.headless = on;
		this.applyHeadless(on);
		this.refreshTrayMenu();
	}

	private applyHeadless(on: boolean) {
		const { app: electronApp, BrowserWindow } = this.remote;
		if (on) {
			for (const win of BrowserWindow.getAllWindows()) win.hide();
			if (Platform.isMacOS && this.settings.hideDockIcon) {
				electronApp.dock?.hide();
			}
		} else {
			if (Platform.isMacOS) electronApp.dock?.show();
			// dock.show() is async; give macOS a beat before raising windows
			// so the app can become active and actually take focus.
			setTimeout(() => {
				for (const win of BrowserWindow.getAllWindows()) win.show();
				try {
					this.remote.getCurrentWindow().focus();
				} catch {
					/* window may have been closed */
				}
			}, 100);
		}
	}

	private createTray() {
		const { Tray } = this.remote;
		const stale = (window as any)[TRAY_GLOBAL];
		if (stale && !stale.isDestroyed?.()) stale.destroy();

		this.tray = new Tray(createTrayIcon(this.remote, this.settings.trayIconColor));
		this.tray.setToolTip("Obsidian");
		(window as any)[TRAY_GLOBAL] = this.tray;
		this.refreshTrayMenu();
	}

	refreshTrayMenu() {
		if (!this.tray || this.tray.isDestroyed?.()) return;
		const { Menu } = this.remote;
		const template: any[] = [
			{
				label: "Headless",
				type: "checkbox",
				checked: this.headless,
				click: (item: any) => this.setHeadless(item.checked),
			},
			{ type: "separator" },
			{
				label: "Open Obsidian",
				enabled: this.headless,
				click: () => this.setHeadless(false),
			},
			{ type: "separator" },
			{
				label: "Quit Obsidian",
				click: () => {
					this.destroyTray();
					this.remote.app.quit();
				},
			},
		];
		this.tray.setContextMenu(Menu.buildFromTemplate(template));
	}

	refreshTrayIcon() {
		if (!this.tray || this.tray.isDestroyed?.()) return;
		this.tray.setImage(createTrayIcon(this.remote, this.settings.trayIconColor));
	}

	private destroyTray() {
		if (this.tray && !this.tray.isDestroyed?.()) this.tray.destroy();
		this.tray = null;
		(window as any)[TRAY_GLOBAL] = undefined;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class HeadlessModeSettingTab extends PluginSettingTab {
	plugin: HeadlessModePlugin;

	constructor(app: App, plugin: HeadlessModePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Start headless")
			.setDesc(
				"Launch Obsidian directly into headless mode: windows hidden, only the menu bar icon visible."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.startHeadless)
					.onChange(async (value) => {
						this.plugin.settings.startHeadless = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Hide Dock icon while headless")
			.setDesc(
				"macOS only. Remove Obsidian from the Dock while headless; it returns when you uncheck Headless in the menu bar."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hideDockIcon)
					.onChange(async (value) => {
						this.plugin.settings.hideDockIcon = value;
						await this.plugin.saveSettings();
						// If we're currently headless, apply the change live.
						if (this.plugin.headless && Platform.isMacOS) {
							const remote = getElectronRemote();
							if (value) remote?.app.dock?.hide();
							else remote?.app.dock?.show();
						}
					})
			);

		new Setting(containerEl)
			.setName("Menu bar icon color")
			.setDesc(
				"White and Black force an explicit color. Auto uses a macOS template image that the system tints to match the menu bar (may render black on translucent menu bars)."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("white", "White")
					.addOption("black", "Black")
					.addOption("auto", "Auto (macOS template)")
					.setValue(this.plugin.settings.trayIconColor)
					.onChange(async (value) => {
						this.plugin.settings.trayIconColor = value as TrayIconColor;
						await this.plugin.saveSettings();
						this.plugin.refreshTrayIcon();
					})
			);
	}
}
