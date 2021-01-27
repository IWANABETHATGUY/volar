import { TextDocument } from 'vscode-languageserver-textdocument';
import { uriToFsPath } from '@volar/shared';
import { computed, ref, Ref } from '@vue/reactivity';
import { IDescriptor, ITemplateScriptData } from '../types';
import * as upath from 'upath';
import { MapedMode, TsSourceMap, Mapping, CssSourceMap, createScriptGenerator, TeleportMappingData, TeleportSourceMap } from '../utils/sourceMaps';
import { transformVueHtml } from '../utils/vueHtmlConverter';
import { hyphenate } from '@vue/shared';
import * as globalServices from '../globalServices';
import * as css from 'vscode-css-languageservice';
import { SearchTexts } from './common';

export function useTemplateScript(
	getUnreactiveDoc: () => TextDocument,
	template: Ref<IDescriptor['template']>,
	templateScriptData: ITemplateScriptData,
	styleDocuments: Ref<{
		textDocument: TextDocument;
		stylesheet: css.Stylesheet;
		links: {
			textDocument: TextDocument;
			stylesheet: css.Stylesheet;
		}[];
		module: boolean;
		scoped: boolean;
	}[]>,
	styleSourceMaps: Ref<CssSourceMap[]>,
	templateData: Ref<{
		html?: string,
		htmlToTemplate?: (start: number, end: number) => number | undefined,
	} | undefined>,
) {
	let version = 0;
	const _vueDoc = getUnreactiveDoc();
	const vueUri = _vueDoc.uri;
	const vueFileName = upath.basename(uriToFsPath(_vueDoc.uri));
	const cssModuleClasses = useCssClasses(styleDocuments, 'module');
	const cssScopedClasses = useCssClasses(styleDocuments, 'scoped');
	const interpolations = computed(() => {
		if (templateData.value?.html === undefined) {
			return;
		}
		return transformVueHtml(
			templateData.value.html,
			templateScriptData.components,
			[...cssScopedClasses.value.values()].map(map => [...map.keys()]).flat(),
			templateData.value.htmlToTemplate,
		);
	});
	const data = computed(() => {
		if (!interpolations.value) {
			return;
		}

		const gen = createScriptGenerator();

		gen.addText(`import { __VLS_options, __VLS_component } from './${vueFileName}';\n`);
		gen.addText(`declare const __VLS_ctx: InstanceType<typeof __VLS_component>;\n`);
		gen.addText(`declare const __VLS_vmUnwrap: typeof __VLS_options & { components: { } };\n`);
		gen.addText(`declare const __VLS_Components: typeof __VLS_vmUnwrap.components & __VLS_GlobalComponents & __VLS_PickComponents<typeof __VLS_ctx>;\n`);

		/* Components */
		gen.addText('/* Components */\n');
		gen.addText('declare const __VLS_components: JSX.IntrinsicElements & typeof __VLS_Components;\n');
		gen.addText('declare const __VLS_componentPropsBase: __VLS_MapPropsTypeBase<typeof __VLS_components>;\n');
		gen.addText('declare const __VLS_componentProps: __VLS_MapPropsType<typeof __VLS_components>;\n');
		gen.addText('declare const __VLS_componentEmits: __VLS_MapEmitType<typeof __VLS_components>;\n');

		/* Completion */
		gen.addText(`({} as __VLS_GlobalAttrs).${SearchTexts.GlobalAttrs};\n`);

		gen.addText('/* Completion: Emits */\n');
		for (const name of [...templateScriptData.components, ...templateScriptData.htmlElements]) {
			if (!hasElement(interpolations.value.tags, name)) continue;
			gen.addText(`// @ts-ignore\n`);
			gen.addText(`__VLS_componentEmits['${name}']('');\n`); // TODO
		}
		gen.addText('/* Completion: Props */\n');
		for (const name of [...templateScriptData.components, ...templateScriptData.htmlElements]) {
			if (!hasElement(interpolations.value.tags, name)) continue;
			gen.addText(`// @ts-ignore\n`);
			gen.addText(`__VLS_componentPropsBase['${name}'][''];\n`); // TODO
		}
		gen.addText('/* Completion: Slots */\n');
		for (const name of [...templateScriptData.components, ...templateScriptData.htmlElements]) {
			if (!hasElement(interpolations.value.tags, name)) continue;
			gen.addText(`// @ts-ignore\n`);
			gen.addText(`__VLS_components['${name}'].__VLS_slots[''];\n`); // TODO
		}

		/* CSS Module */
		gen.addText('/* CSS Module */\n');
		gen.addText('declare const $style: {\n');
		const cssModuleMappings = writeCssClassProperties(cssModuleClasses.value);
		gen.addText('};\n');

		/* Style Scoped */
		gen.addText('/* Style Scoped */\n');
		gen.addText('declare const __VLS_styleScopedClasses: {\n');
		const cssScopedMappings = writeCssClassProperties(cssScopedClasses.value);
		gen.addText('};\n');

		/* Props */
		gen.addText(`/* Props */\n`);
		const ctxMappings = writeProps();

		/* Interpolations */
		gen.addText(`/* Interpolations */\n`);
		// patch
		const crtOffset = gen.getText().length;
		for (const maped of interpolations.value.mappings) {
			gen.addMapping2(
				{
					start: maped.targetRange.start + crtOffset,
					end: maped.targetRange.end + crtOffset,
				},
				maped.sourceRange,
				maped.mode,
				maped.data,
			);
		}
		gen.addText(interpolations.value.text);

		return {
			text: gen.getText(),
			mappings: gen.getMappings(),
			cssModuleMappings,
			cssScopedMappings,
			ctxMappings,
		};

		function writeCssClassProperties(data: Map<string, Map<string, Set<[number, number]>>>) {
			const mappings = new Map<string, {
				tsRange: {
					start: number,
					end: number,
				},
				cssRanges: {
					start: number,
					end: number,
				}[],
				mode: MapedMode,
			}[]>();
			for (const [uri, classes] of data) {
				if (!mappings.has(uri)) {
					mappings.set(uri, []);
				}
				for (const [className, ranges] of classes) {
					mappings.get(uri)!.push({
						tsRange: {
							start: gen.getText().length + 1, // + '
							end: gen.getText().length + 1 + className.length,
						},
						cssRanges: [...ranges].map(range => ({
							start: range[0],
							end: range[1],
						})),
						mode: MapedMode.Offset,
					});
					mappings.get(uri)!.push({
						tsRange: {
							start: gen.getText().length,
							end: gen.getText().length + className.length + 2,
						},
						cssRanges: [...ranges].map(range => ({
							start: range[0],
							end: range[1],
						})),
						mode: MapedMode.Gate,
					});
					gen.addText(`'${className}': string,\n`);
				}
			}
			return mappings;
		}
		function writeProps() {
			const propsSet = new Set(templateScriptData.props);
			const mappings: Mapping<TeleportMappingData>[] = [];
			for (const propName of templateScriptData.context) {
				gen.addText(`declare var `);
				const templateSideRange = gen.addText(propName);
				gen.addText(`: typeof __VLS_ctx.`);
				const scriptSideRange = gen.addText(propName);
				gen.addText(`;`);

				mappings.push({
					data: {
						direction: 'scriptToTemplate',
						isAdditionalReference: false,
						capabilities: {
							definitions: true,
							references: true,
							rename: true,
						},
					},
					mode: MapedMode.Offset,
					sourceRange: scriptSideRange,
					targetRange: templateSideRange,
				});

				if (propsSet.has(propName)) {
					gen.addText(` __VLS_options.props.`);
					const scriptSideRange2 = gen.addText(propName);
					gen.addText(`;`);

					mappings.push({
						data: {
							direction: 'scriptToTemplate',
							isAdditionalReference: true,
							capabilities: {
								definitions: true,
								references: true,
								rename: true,
							},
						},
						mode: MapedMode.Offset,
						sourceRange: scriptSideRange2,
						targetRange: templateSideRange,
					});
				}
				gen.addText(`\n`);
			}
			return mappings;
		}
		function hasElement(tags: Set<string>, tagName: string) {
			return tags.has(tagName) || tags.has(hyphenate(tagName));
		}
	});
	const sourceMap = computed(() => {
		if (data.value && textDocument.value && template.value) {
			const vueDoc = getUnreactiveDoc();
			const sourceMap = new TsSourceMap(vueDoc, textDocument.value, true, { foldingRanges: false, formatting: false, documentSymbol: false });
			for (const [uri, mappings] of [...data.value.cssModuleMappings, ...data.value.cssScopedMappings]) {
				const cssSourceMap = styleSourceMaps.value.find(sourceMap => sourceMap.targetDocument.uri === uri);
				if (!cssSourceMap) continue;
				for (const maped of mappings) {
					const tsRange = maped.tsRange;
					for (const cssRange of maped.cssRanges) {
						const vueLoc = cssSourceMap.targetToSource2(cssRange);
						if (!vueLoc) continue;
						sourceMap.add({
							data: {
								vueTag: 'style',
								capabilities: {
									basic: true,
									references: true,
									definitions: true,
									rename: true,
									diagnostic: true,
									formatting: false,
									completion: true,
									semanticTokens: false,
									referencesCodeLens: maped.mode === MapedMode.Gate, // has 2 modes
								},
							},
							mode: maped.mode,
							sourceRange: vueLoc.range,
							targetRange: tsRange,
						});
					}
				}
			}
			for (const maped of data.value.mappings) {
				sourceMap.add({
					data: maped.data,
					mode: maped.mode,
					sourceRange: {
						start: maped.sourceRange.start + template.value.loc.start,
						end: maped.sourceRange.end + template.value.loc.start,
					},
					targetRange: maped.targetRange,
				});
			}

			return sourceMap;
		}
	});
	const sourceMapForFormatting = computed(() => {
		if (interpolations.value && textDocumentForFormatting.value && template.value) {
			const vueDoc = getUnreactiveDoc();
			const sourceMap = new TsSourceMap(vueDoc, textDocumentForFormatting.value, true, { foldingRanges: false, formatting: true, documentSymbol: false });
			for (const maped of interpolations.value.formapMappings) {
				sourceMap.add({
					data: maped.data,
					mode: maped.mode,
					sourceRange: {
						start: maped.sourceRange.start + template.value.loc.start,
						end: maped.sourceRange.end + template.value.loc.start,
					},
					targetRange: maped.targetRange,
				});
			}
			return sourceMap;
		}
	});
	const cssTextDocument = computed(() => {
		if (interpolations.value && template.value) {
			const textDocument = TextDocument.create(vueUri + '.template.css', 'css', 0, interpolations.value.cssCode);
			const stylesheet = globalServices.css.parseStylesheet(textDocument);
			return {
				textDocument,
				stylesheet,
				links: [],
				module: false,
				scoped: false,
				ignore: template.value.ignore,
			};
		}
	});
	const cssSourceMap = computed(() => {
		if (interpolations.value && cssTextDocument.value && template.value) {
			const vueDoc = getUnreactiveDoc();
			const sourceMap = new CssSourceMap(
				vueDoc,
				cssTextDocument.value.textDocument,
				cssTextDocument.value.stylesheet,
				false,
				false,
				[],
				{ foldingRanges: false, formatting: false },
			);
			for (const maped of interpolations.value.cssMappings) {
				sourceMap.add({
					data: undefined,
					mode: maped.mode,
					sourceRange: {
						start: maped.sourceRange.start + template.value.loc.start,
						end: maped.sourceRange.end + template.value.loc.start,
					},
					targetRange: maped.targetRange,
				});
			}
			return sourceMap;
		}
	});
	const textDocument = ref<TextDocument>();
	const textDocumentForFormatting = ref<TextDocument>();
	const teleportSourceMap = ref<TeleportSourceMap>();

	return {
		sourceMap,
		textDocument,
		textDocumentForFormatting,
		sourceMapForFormatting,
		teleportSourceMap,
		cssTextDocument,
		cssSourceMap,
		update, // TODO: cheapComputed
	};

	function update() {
		if (data.value?.text !== textDocument.value?.getText()) {
			if (data.value && interpolations.value) {
				const _version = version++;
				textDocument.value = TextDocument.create(vueUri + '.__VLS_template.ts', 'typescript', _version, data.value.text);
				textDocumentForFormatting.value = TextDocument.create(vueUri + '.__VLS_template.format.ts', 'typescript', _version, interpolations.value.formatCode);

				const sourceMap = new TeleportSourceMap(textDocument.value);
				for (const maped of data.value.ctxMappings) {
					sourceMap.add(maped);
				}
				teleportSourceMap.value = sourceMap;
			}
			else {
				textDocument.value = undefined;
				teleportSourceMap.value = undefined;
				textDocumentForFormatting.value = undefined;
			}
		}
	}
}

function useCssClasses(
	styleDocuments: Ref<{
		textDocument: TextDocument;
		stylesheet: css.Stylesheet;
		links: {
			textDocument: TextDocument;
			stylesheet: css.Stylesheet;
		}[];
		module: boolean;
		scoped: boolean;
	}[]>,
	type: 'module' | 'scoped',
) {
	return computed(() => {
		const result = new Map<string, Map<string, Set<[number, number]>>>();
		for (const sourceMap of styleDocuments.value) {
			if (type === 'module' && !sourceMap.module)
				continue;
			if (type === 'scoped' && !sourceMap.scoped)
				continue;
			for (const [className, offsets] of findClassNames(sourceMap.textDocument, sourceMap.stylesheet)) {
				for (const offset of offsets) {
					addClassName(sourceMap.textDocument.uri, className, offset);
				}
			}
			for (const link of sourceMap.links) {
				for (const [className, offsets] of findClassNames(link.textDocument, link.stylesheet)) {
					for (const offset of offsets) {
						addClassName(link.textDocument.uri, className, offset);
					}
				}
			}
		}
		return result;
		function addClassName(uri: string, className: string, range: [number, number]) {
			if (!result.has(uri))
				result.set(uri, new Map());
			if (!result.get(uri)!.has(className))
				result.get(uri)!.set(className, new Set());
			result.get(uri)!.get(className)?.add(range);
		}
	});
}
function findClassNames(doc: TextDocument, ss: css.Stylesheet) {
	const result = new Map<string, Set<[number, number]>>();
	const cssLanguageService = globalServices.getCssService(doc.languageId);
	if (!cssLanguageService) return result;
	const symbols = cssLanguageService.findDocumentSymbols(doc, ss);
	const usedNodes = new Set<number>();
	for (const s of symbols) {
		if (s.kind === css.SymbolKind.Class) {
			const nodeText = doc.getText(s.location.range);
			// https://stackoverflow.com/questions/448981/which-characters-are-valid-in-css-class-names-selectors
			const classNames_1 = s.name.matchAll(/(?<=\.)-?[_a-zA-Z]+[_a-zA-Z0-9-]*/g);
			const classNames_2 = nodeText.matchAll(/(?<=\.)-?[_a-zA-Z]+[_a-zA-Z0-9-]*/g);

			for (const _className_1 of classNames_1) {
				if (_className_1.index === undefined) continue;
				const className_1 = _className_1.toString();
				for (const _className_2 of classNames_2) {
					if (_className_2.index === undefined) continue;
					const className_2 = _className_2.toString();
					if (className_1 === className_2) {
						if (!result.has(className_1)) {
							result.set(className_1, new Set());
						}
						const startIndex = doc.offsetAt(s.location.range.start) + _className_2.index - 1;
						if (usedNodes.has(startIndex)) continue;
						usedNodes.add(startIndex);
						result.get(className_1)!.add([startIndex, startIndex + className_1.length + 1]);
						break;
					}
				}
			}
		}
	}
	return result;
}
