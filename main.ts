import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	Platform,
	requestUrl,
} from "obsidian";

/** GitHub repo releases are the update channel for this sideloaded plugin. */
const GITHUB_REPO = "powderfirm-ship-it/obsidian-headless-mode";
const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

interface AvailableUpdate {
	version: string;
	/** asset filename -> browser_download_url */
	assets: Record<string, string>;
}

function isNewerVersion(candidate: string, current: string): boolean {
	const a = candidate.split(".").map((n) => parseInt(n, 10) || 0);
	const b = current.split(".").map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff > 0;
	}
	return false;
}

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
 * assets. A template image (pure black + alpha) lets macOS tint it correctly
 * for light/dark menu bars.
 */
function createTrayIcon(remote: any, color: TrayIconColor): any {
	// Template mode requires pure black + alpha; explicit colors must not be
	// template images or macOS will re-tint them.
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
	availableUpdate: AvailableUpdate | null = null;
	private lastNotifiedVersion: string | null = null;
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
		this.addCommand({
			id: "check-updates",
			name: "Check for updates",
			callback: () => this.checkForUpdate(true),
		});

		this.addSettingTab(new HeadlessModeSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			if (this.settings.startHeadless) this.setHeadless(true);
			// Update check shouldn't compete with startup; defer it.
			window.setTimeout(() => this.checkForUpdate(), 10_000);
		});
		this.registerInterval(
			window.setInterval(() => this.checkForUpdate(), UPDATE_CHECK_INTERVAL_MS)
		);
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
		];
		if (this.availableUpdate) {
			template.push(
				{ type: "separator" },
				{
					label: `Update available (${this.availableUpdate.version}) — Install`,
					click: () => this.installUpdate(),
				}
			);
		}
		template.push(
			{ type: "separator" },
			{
				label: "Quit Obsidian",
				click: () => {
					this.destroyTray();
					this.remote.app.quit();
				},
			}
		);
		this.tray.setContextMenu(Menu.buildFromTemplate(template));
	}

	/**
	 * Compare the latest GitHub release against the installed manifest version
	 * and surface "update available" in the tray menu, settings, and a Notice.
	 */
	async checkForUpdate(interactive = false) {
		try {
			const res = await requestUrl({
				url: `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
				headers: { Accept: "application/vnd.github+json" },
			});
			const release = res.json;
			const latest = String(release.tag_name ?? "").replace(/^v/, "");
			if (latest && isNewerVersion(latest, this.manifest.version)) {
				const assets: Record<string, string> = {};
				for (const asset of release.assets ?? []) {
					assets[asset.name] = asset.browser_download_url;
				}
				this.availableUpdate = { version: latest, assets };
				if (interactive || this.lastNotifiedVersion !== latest) {
					this.lastNotifiedVersion = latest;
					new Notice(
						`Headless Mode ${latest} is available — install it from the tray menu or the plugin settings.`,
						10_000
					);
				}
			} else {
				this.availableUpdate = null;
				if (interactive) new Notice("Headless Mode is up to date.");
			}
			this.refreshTrayMenu();
		} catch (e) {
			console.error("Headless Mode: update check failed", e);
			if (interactive) new Notice("Headless Mode: update check failed (offline or rate-limited).");
		}
	}

	/**
	 * Download main.js + manifest.json from the latest release into this
	 * plugin's folder, then reload the plugin so the new version runs.
	 */
	async installUpdate() {
		const update = this.availableUpdate;
		if (!update) return;
		const pluginDir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		const files = ["main.js", "manifest.json"];
		try {
			// Fetch everything before writing anything, so a failed download
			// can't leave a half-updated plugin on disk.
			const downloaded: Record<string, string> = {};
			for (const name of files) {
				const url = update.assets[name];
				if (!url) {
					new Notice(`Headless Mode: release ${update.version} is missing ${name}; not updating.`);
					return;
				}
				downloaded[name] = (await requestUrl({ url })).text;
			}
			for (const name of files) {
				await this.app.vault.adapter.write(`${pluginDir}/${name}`, downloaded[name]);
			}
			new Notice(`Headless Mode updated to ${update.version} — reloading plugin.`);
			const plugins = (this.app as any).plugins;
			await plugins.disablePlugin(this.manifest.id);
			await plugins.enablePlugin(this.manifest.id);
		} catch (e) {
			console.error("Headless Mode: update install failed", e);
			new Notice("Headless Mode: update failed — see developer console.");
		}
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

		new Setting(containerEl).setName("Updates").setHeading();

		const update = this.plugin.availableUpdate;
		const updateSetting = new Setting(containerEl)
			.setName(`Installed version: ${this.plugin.manifest.version}`)
			.setDesc(
				update
					? `Update available: ${update.version} (from github.com/${GITHUB_REPO})`
					: "Updates are pulled from the plugin's GitHub releases."
			);
		if (update) {
			updateSetting.addButton((btn) =>
				btn
					.setButtonText(`Install ${update.version}`)
					.setCta()
					.onClick(() => this.plugin.installUpdate())
			);
		}
		updateSetting.addButton((btn) =>
			btn.setButtonText("Check now").onClick(async () => {
				await this.plugin.checkForUpdate(true);
				this.display();
			})
		);
	}
}
