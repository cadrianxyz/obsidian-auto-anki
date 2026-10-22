// A small stand-in for the parts of Obsidian's API that Auto Anki uses, so the plugin can
// be loaded and driven from Node. The test runner (test/run.mjs) swaps it in for the real
// "obsidian" module when it bundles each test file.
//
// It records what the plugin does (notices shown, files written, modals opened, requests
// made) in `fake`, which tests read and reset.

export const fake = {
	notices: [],
	modals: [],
	ankiRequests: [],
	ankiHandler: null,
	reset() {
		this.notices.length = 0;
		this.modals.length = 0;
		this.ankiRequests.length = 0;
		this.ankiHandler = null;
	},
};

// ---- A minimal element tree (Obsidian adds createEl/createDiv/... to every element) ----

export class FakeElement {
	constructor(tag = 'div', opts = {}) {
		this.tagName = tag;
		this.children = [];
		this.text = '';
		this.className = '';
		this.attrs = {};
		this.type = 'text';
		this.onclick = null;
		const classes = new Set();
		this.classList = {
			add: (c) => classes.add(c),
			remove: (c) => classes.delete(c),
			contains: (c) => classes.has(c),
		};
		applyOpts(this, opts);
	}
	get textContent() {
		return this.text + this.children.map((c) => c.textContent).join('');
	}
	set textContent(v) {
		this.text = String(v);
		this.children = [];
	}
	createEl(tag, opts) {
		const el = new FakeElement(tag, opts);
		this.children.push(el);
		return el;
	}
	createDiv(opts) { return this.createEl('div', opts); }
	createSpan(opts) { return this.createEl('span', opts); }
	appendText(t) { this.children.push(Object.assign(new FakeElement('#text'), { text: t })); }
	appendChild(el) { this.children.push(el); return el; }
	empty() { this.children = []; this.text = ''; }
	// Depth-first list of this element and everything inside it.
	all() { return [this, ...this.children.flatMap((c) => (c.all ? c.all() : []))]; }
	click() { return this.onclick?.({}); }
}

function applyOpts(el, opts) {
	if (typeof opts === 'string') { el.text = opts; return; }
	if (!opts) return;
	if (opts.text !== undefined) el.text = String(opts.text);
	if (opts.cls) el.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : opts.cls;
	if (opts.href) el.attrs.href = opts.href;
}

globalThis.createEl = (tag, opts) => new FakeElement(tag, opts);
globalThis.createDiv = (opts) => new FakeElement('div', opts);
globalThis.createSpan = (opts) => new FakeElement('span', opts);
globalThis.createFragment = (cb) => { const f = new FakeElement('#fragment'); cb?.(f); return f; };

// ---- Notices ----

export class Notice {
	constructor(message, duration) {
		this.message = typeof message === 'string' ? message : message.textContent;
		this.duration = duration;
		fake.notices.push(this.message);
	}
	hide() {}
}

// ---- Settings UI components ----

class ValueComponent {
	constructor() { this.value = ''; this.disabled = false; this.changeHandler = null; }
	setValue(v) { this.value = v; return this; }
	getValue() { return this.value; }
	setPlaceholder(p) { this.placeholder = p; return this; }
	setDisabled(d) { this.disabled = d; return this; }
	onChange(cb) { this.changeHandler = cb; return this; }
	// What typing into the box does: the value changes, then onChange runs.
	async type(v) { this.value = v; return this.changeHandler?.(v); }
}

class TextComponent extends ValueComponent {
	constructor() { super(); this.inputEl = new FakeElement('input'); }
}

class DropdownComponent extends ValueComponent {
	constructor() { super(); this.options = {}; }
	addOption(value, label) { this.options[value] = label; return this; }
}

class ButtonComponent {
	constructor() { this.text = ''; this.disabled = false; this.handler = null; }
	setButtonText(t) { this.text = t; return this; }
	setCta() { return this; }
	setClass() { return this; }
	setDisabled(d) { this.disabled = d; return this; }
	onClick(cb) { this.handler = cb; return this; }
	async click() { if (!this.disabled) return this.handler?.({}); }
}

export class Setting {
	constructor(containerEl) {
		this.settingEl = new FakeElement('div', { cls: 'setting-item' });
		this.settingEl.setting = this;
		this.components = [];
		this.name = '';
		this.heading = false;
		containerEl.appendChild(this.settingEl);
	}
	setName(n) { this.name = n; return this; }
	setDesc(d) { this.desc = typeof d === 'string' ? d : d.textContent; return this; }
	setHeading() { this.heading = true; return this; }
	add(component, cb) { this.components.push(component); cb(component); return this; }
	addText(cb) { return this.add(new TextComponent(), cb); }
	addDropdown(cb) { return this.add(new DropdownComponent(), cb); }
	addButton(cb) { return this.add(new ButtonComponent(), cb); }
	addSlider(cb) { return this.add(new ValueComponent(), cb); }
	addToggle(cb) { return this.add(new ValueComponent(), cb); }
}

// Every Setting under an element, in order.
export function settingsIn(el) {
	return el.all().filter((e) => e.setting).map((e) => e.setting);
}

// Every button under an element: Setting buttons and plain <button> elements.
export function buttonsIn(el) {
	return [
		...settingsIn(el).flatMap((s) => s.components.filter((c) => c instanceof ButtonComponent)),
		...el.all().filter((e) => e.tagName === 'button').map((e) => ({ text: e.text, click: () => e.click() })),
	];
}

// ---- Plugin, settings tab, modal ----

export class Component {
	load() {}
	unload() {}
	register() {}
	registerEvent() {}
	registerInterval(id) { return id; }
	addChild(c) { return c; }
}

export class Plugin extends Component {
	constructor(app, manifest) {
		super();
		this.app = app;
		this.manifest = manifest;
		this.commands = [];
		this.settingTabs = [];
	}
	// data.json lives in app.disk, so two "devices" can share it, like a synced vault.
	async loadData() {
		const raw = this.app.disk.files['data.json'];
		if (raw === undefined) return null;
		return JSON.parse(raw);
	}
	async saveData(data) {
		this.app.disk.files['data.json'] = JSON.stringify(data, null, 2);
		this.app.disk.writes += 1;
	}
	addCommand(cmd) { this.commands.push(cmd); return cmd; }
	addSettingTab(tab) { this.settingTabs.push(tab); }
	addStatusBarItem() { return new FakeElement('div'); }
	addRibbonIcon() { return new FakeElement('div'); }
}

export class PluginSettingTab {
	constructor(app, plugin) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = new FakeElement('div');
	}
}

export class Modal {
	constructor(app) {
		this.app = app;
		this.contentEl = new FakeElement('div');
		this.isOpen = false;
	}
	open() {
		this.isOpen = true;
		fake.modals.push(this);
		this.opened = Promise.resolve(this.onOpen?.());
	}
	close() {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.onClose?.();
	}
}

export class MarkdownView {}
export class Editor {}
export class App {}

export function setIcon(el, icon) { el.icon = icon; }

// ---- requestUrl, used for AnkiConnect ----

export async function requestUrl(req) {
	const body = req.body ? JSON.parse(req.body) : undefined;
	fake.ankiRequests.push({ url: req.url, body });
	if (!fake.ankiHandler) throw new Error('net::ERR_CONNECTION_REFUSED');
	const reply = await fake.ankiHandler(body, req);
	const status = reply?.status ?? 200;
	if (req.throw !== false && status >= 400) throw new Error(`Request failed, status ${status}`);
	return { status, json: reply?.json, text: JSON.stringify(reply?.json) };
}
