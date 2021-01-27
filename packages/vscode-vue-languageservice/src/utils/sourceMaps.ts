import type { Range } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { HTMLDocument } from 'vscode-html-languageservice';
import type { Stylesheet } from 'vscode-css-languageservice';

export interface MapedRange {
	start: number,
	end: number,
}

export enum MapedMode {
	Offset,
	Gate,
	In,
}

export type Mapping<T> = {
	data: T,
	mode: MapedMode,
	sourceRange: MapedRange,
	targetRange: MapedRange,
	others?: {
		mode: MapedMode,
		sourceRange: MapedRange,
		targetRange: MapedRange,
	}[],
}

export class SourceMap<MapedData = unknown> extends Set<Mapping<MapedData>> {

	constructor(
		public sourceDocument: TextDocument,
		public targetDocument: TextDocument,
	) {
		super();
	}

	// Range
	public isSource(range: Range) {
		return this.maps(range, true, true).length > 0;
	}
	public isTarget(range: Range) {
		return this.maps(range, false, true).length > 0;
	}
	public targetToSource(range: Range) {
		const result = this.maps(range, false, true);
		if (result.length) return result[0];
	}
	public sourceToTarget(range: Range) {
		const result = this.maps(range, true, true);
		if (result.length) return result[0];
	}
	public targetToSources(range: Range) {
		return this.maps(range, false);
	}
	public sourceToTargets(range: Range) {
		return this.maps(range, true);
	}
	private maps(range: Range, sourceToTarget: boolean, returnFirstResult?: boolean) {
		const toDoc = sourceToTarget ? this.targetDocument : this.sourceDocument;
		const fromDoc = sourceToTarget ? this.sourceDocument : this.targetDocument;
		const fromRange = {
			start: fromDoc.offsetAt(range.start),
			end: fromDoc.offsetAt(range.end),
		};
		return this
			.maps2(fromRange, sourceToTarget, returnFirstResult)
			.map(result => ({
				data: result.data,
				range: {
					start: toDoc.positionAt(result.range.start),
					end: toDoc.positionAt(result.range.end),
				} as Range,
			}));
	}

	// MapedRange
	public isSource2(range: MapedRange) {
		return this.maps2(range, true, true).length > 0;
	}
	public isTarget2(range: MapedRange) {
		return this.maps2(range, false, true).length > 0;
	}
	public targetToSource2(range: MapedRange) {
		const result = this.maps2(range, false, true);
		if (result.length) return result[0];
	}
	public sourceToTarget2(range: MapedRange) {
		const result = this.maps2(range, true, true);
		if (result.length) return result[0];
	}
	public targetToSources2(range: MapedRange) {
		return this.maps2(range, false);
	}
	public sourceToTargets2(range: MapedRange) {
		return this.maps2(range, true);
	}
	private maps2(fromRange: MapedRange, sourceToTarget: boolean, returnFirstResult?: boolean) {
		const result: {
			data: MapedData,
			range: MapedRange,
		}[] = [];
		for (const maped of this) {
			const ranges = [{
				mode: maped.mode,
				sourceRange: maped.sourceRange,
				targetRange: maped.targetRange,
			}, ...maped.others ?? []];
			for (const maped_2 of ranges) {
				const mapedToRange = sourceToTarget ? maped_2.targetRange : maped_2.sourceRange;
				const mapedFromRange = sourceToTarget ? maped_2.sourceRange : maped_2.targetRange;
				if (maped_2.mode === MapedMode.Gate) {
					if (fromRange.start === mapedFromRange.start && fromRange.end === mapedFromRange.end) {
						const offsets = [mapedToRange.start, mapedToRange.end];
						result.push({
							data: maped.data,
							range: {
								start: Math.min(offsets[0], offsets[1]),
								end: Math.max(offsets[0], offsets[1]),
							},
						});
						if (returnFirstResult) return result;
						break;
					}
				}
				else if (maped_2.mode === MapedMode.Offset) {
					if (fromRange.start >= mapedFromRange.start && fromRange.end <= mapedFromRange.end) {
						const offsets = [mapedToRange.start + fromRange.start - mapedFromRange.start, mapedToRange.end + fromRange.end - mapedFromRange.end];
						result.push({
							data: maped.data,
							range: {
								start: Math.min(offsets[0], offsets[1]),
								end: Math.max(offsets[0], offsets[1]),
							},
						});
						if (returnFirstResult) return result;
						break;
					}
				}
				else if (maped_2.mode === MapedMode.In) {
					if (fromRange.start >= mapedFromRange.start && fromRange.end <= mapedFromRange.end) {
						const offsets = [mapedToRange.start, mapedToRange.end];
						result.push({
							data: maped.data,
							range: {
								start: Math.min(offsets[0], offsets[1]),
								end: Math.max(offsets[0], offsets[1]),
							},
						});
						if (returnFirstResult) return result;
						break;
					}
				}
			}
		}
		return result;
	}
}

export interface TsMappingData {
	vueTag: 'template' | 'script' | 'scriptSetup' | 'style' | 'scriptSrc',
	beforeRename?: (newName: string) => string,
	doRename?: (oldName: string, newName: string) => string,
	capabilities: {
		basic?: boolean,
		references?: boolean,
		definitions?: boolean,
		diagnostic?: boolean,
		formatting?: boolean,
		rename?: boolean | {
			in: boolean,
			out: boolean,
		},
		completion?: boolean,
		semanticTokens?: boolean,
		foldingRanges?: boolean,
		referencesCodeLens?: boolean,
		displayWithLink?: boolean,
	},
}

export interface TeleportMappingData {
	direction: 'sibling' | 'scriptToTemplate';
	isAdditionalReference?: boolean;
	// TODO: transforms
	editRenameTextToTarget?: (newName: string) => string,
	editRenameTextToSource?: (newName: string) => string,
	capabilities: {
		references?: boolean,
		definitions?: boolean,
		rename?: boolean,
	},
}

export class TsSourceMap extends SourceMap<TsMappingData> {
	constructor(
		public sourceDocument: TextDocument,
		public targetDocument: TextDocument,
		public isInterpolation: boolean,
		public capabilities: {
			foldingRanges: boolean,
			formatting: boolean,
			documentSymbol: boolean,
		},
	) {
		super(sourceDocument, targetDocument);
	}
}

export class CssSourceMap extends SourceMap<undefined> {
	constructor(
		public sourceDocument: TextDocument,
		public targetDocument: TextDocument,
		public stylesheet: Stylesheet,
		public module: boolean,
		public scoped: boolean,
		public links: { textDocument: TextDocument, stylesheet: Stylesheet }[],
		public capabilities: {
			foldingRanges: boolean,
			formatting: boolean,
		},
	) {
		super(sourceDocument, targetDocument);
	}
}

export class HtmlSourceMap extends SourceMap<undefined> {
	constructor(
		public sourceDocument: TextDocument,
		public targetDocument: TextDocument,
		public htmlDocument: HTMLDocument,
	) {
		super(sourceDocument, targetDocument);
	}
}

export class PugSourceMap extends SourceMap<undefined> {
	constructor(
		public sourceDocument: TextDocument,
		public targetDocument: TextDocument,
		public html: string | undefined,
		public mapper: ((htmlStart: number, htmlEnd: number) => number | undefined) | undefined,
	) {
		super(sourceDocument, targetDocument);
	}
}

export class TeleportSourceMap extends SourceMap<TeleportMappingData> {
	constructor(
		public document: TextDocument,
	) {
		super(document, document);
	}
	findTeleports(range: Range, from: TsMappingData['vueTag']) {
		const result: {
			data: TeleportMappingData;
			range: Range;
			editRenameText?: (newName: string) => string;
		}[] = [];
		for (const loc of this.sourceToTargets(range)) {
			if (
				loc.data.direction === 'sibling'
				|| (loc.data.direction === 'scriptToTemplate' && (from === 'script' || from === 'scriptSetup'))
			) {
				result.push({
					...loc,
					editRenameText: loc.data.editRenameTextToTarget,
				});
			}
		}
		for (const loc of this.targetToSources(range)) {
			if (
				loc.data.direction === 'sibling'
				|| (loc.data.direction === 'scriptToTemplate' && from === 'template')
			) {
				result.push({
					...loc,
					editRenameText: loc.data.editRenameTextToSource,
				});
			}
		}
		return result;
	}
}

export type ScriptGenerator = ReturnType<typeof createScriptGenerator>;

export function createScriptGenerator<T = TsMappingData>() {
	let text = '';
	const mappings: Mapping<T>[] = [];

	return {
		getText: () => text,
		getMappings: () => mappings,
		addText,
		addCode,
		addMapping,
		addMapping2,
	}

	function addCode(str: string, sourceRange: MapedRange, mode: MapedMode, data: T) {
		const range = addText(str);
		addMapping2(range, sourceRange, mode, data);
		return range;
	}
	function addMapping(str: string, sourceRange: MapedRange, mode: MapedMode, data: T) {
		const range = {
			start: text.length,
			end: text.length + str.length,
		};
		addMapping2(range, sourceRange, mode, data);
		return range;
	}
	function addMapping2(targetRange: MapedRange, sourceRange: MapedRange, mode: MapedMode, data: T) {
		mappings.push({
			data,
			mode,
			sourceRange,
			targetRange,
		});
	}
	function addText(str: string) {
		const range = {
			start: text.length,
			end: text.length + str.length,
		};
		text += str;
		return range;
	}
}
