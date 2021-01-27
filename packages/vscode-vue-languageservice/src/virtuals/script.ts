import { TextDocument } from 'vscode-languageserver-textdocument';
import { syntaxToLanguageId, getValidScriptSyntax } from '@volar/shared';
import { computed, Ref } from '@vue/reactivity';
import { IDescriptor } from '../types';
import { MapedMode, TsSourceMap, MapedRange, Mapping, TeleportSourceMap, TeleportMappingData, createScriptGenerator } from '../utils/sourceMaps';
import { SearchTexts } from './common';
import type * as ts from 'typescript';
import { transformVueHtml } from '../utils/vueHtmlConverter';
import { getTypescript } from '@volar/vscode-builtin-packages';

export function useScriptSetupGen(
	vueDoc: Ref<TextDocument>,
	script: Ref<IDescriptor['script']>,
	scriptSetup: Ref<IDescriptor['scriptSetup']>,
	html: Ref<string | undefined>,
) {
	let version = 0;
	const uri = vueDoc.value.uri;
	const scriptAst = useScriptAst(script);
	const scriptSetupAst = useScriptSetupAst(scriptSetup);
	const generate = useGenerate(script, scriptSetup, scriptAst, scriptSetupAst);
	const generateForSuggestion = useGenerateForSuggestion(script, scriptSetup, scriptSetupAst, html);
	const textDocument = computed(() => {
		if (!generate.value) return;

		const lang = scriptSetup.value && scriptSetup.value.lang !== 'js' ? getValidScriptSyntax(scriptSetup.value.lang) :
			script.value && script.value.lang !== 'js' ? getValidScriptSyntax(script.value.lang) :
				getValidScriptSyntax('js')

		return TextDocument.create(`${uri}.__VLS_script.${lang}`, syntaxToLanguageId(lang), version++, generate.value.code);
	});
	const textDocumentForTemplate = computed(() => {
		if (textDocument.value?.languageId === 'javascript') {
			const lang = 'ts';
			return TextDocument.create(`${uri}.__VLS_script.${lang}`, syntaxToLanguageId(lang), textDocument.value.version, textDocument.value.getText());
		}
	});
	const textDocumentForSuggestion = computed(() => {
		if (!generateForSuggestion.value) return;

		const lang = scriptSetup.value && scriptSetup.value.lang !== 'js' ? getValidScriptSyntax(scriptSetup.value.lang)
			: script.value && script.value.lang !== 'js' ? getValidScriptSyntax(script.value.lang)
				: getValidScriptSyntax('js')

		return TextDocument.create(`${uri}.__VLS_script.suggestion.${lang}`, syntaxToLanguageId(lang), version++, generateForSuggestion.value.code);
	});
	const sourceMap = computed(() => {
		if (!generate.value) return;
		if (!textDocument.value) return;

		const sourceMap = new TsSourceMap(vueDoc.value, textDocument.value, false, { foldingRanges: false, formatting: false, documentSymbol: true });

		for (const mapping of generate.value.mappings) {
			if (mapping.data.vueTag === 'scriptSrc' && script.value?.src) {
				const vueStart = vueDoc.value.getText().substring(0, script.value.loc.start).lastIndexOf(script.value.src); // TODO: don't use indexOf()
				const vueEnd = vueStart + script.value.src.length;
				sourceMap.add({
					...mapping,
					sourceRange: {
						start: vueStart - 1,
						end: vueEnd + 1,
					},
				});
			}
			else if (mapping.data.vueTag === 'script' && script.value) {
				sourceMap.add({
					...mapping,
					sourceRange: {
						start: script.value.loc.start + mapping.sourceRange.start,
						end: script.value.loc.start + mapping.sourceRange.end,
					},
				});
			}
			else if (mapping.data.vueTag === 'scriptSetup' && scriptSetup.value) {
				sourceMap.add({
					...mapping,
					sourceRange: {
						start: scriptSetup.value.loc.start + mapping.sourceRange.start,
						end: scriptSetup.value.loc.start + mapping.sourceRange.end,
					},
				});
			}
		}

		return sourceMap;
	});
	const sourceMapForTemplate = computed(() => {
		if (textDocumentForTemplate.value && sourceMap.value) {
			const newSourceMap = new TsSourceMap(
				sourceMap.value.sourceDocument,
				textDocumentForTemplate.value,
				sourceMap.value.isInterpolation,
				{ foldingRanges: false, formatting: false, documentSymbol: false },
			);
			for (const maped of sourceMap.value) {
				newSourceMap.add({
					...maped,
					data: {
						...maped.data,
						capabilities: {
							references: maped.data.capabilities.references,
							definitions: maped.data.capabilities.definitions,
							rename: maped.data.capabilities.rename,
							referencesCodeLens: maped.data.capabilities.referencesCodeLens,
						},
					},
				})
			}
			return newSourceMap;
		}
	});
	const sourceMapForSuggestion = computed(() => {
		if (!generateForSuggestion.value) return;
		if (!textDocumentForSuggestion.value) return;

		const sourceMap = new TsSourceMap(vueDoc.value, textDocumentForSuggestion.value, false, { foldingRanges: false, formatting: false, documentSymbol: false });

		for (const mapping of generateForSuggestion.value.mappings) {
			if (mapping.data.vueTag === 'script' && script.value) {
				sourceMap.add({
					...mapping,
					sourceRange: {
						start: script.value.loc.start + mapping.sourceRange.start,
						end: script.value.loc.start + mapping.sourceRange.end,
					},
				});
			}
			else if (mapping.data.vueTag === 'scriptSetup' && scriptSetup.value) {
				sourceMap.add({
					...mapping,
					sourceRange: {
						start: scriptSetup.value.loc.start + mapping.sourceRange.start,
						end: scriptSetup.value.loc.start + mapping.sourceRange.end,
					},
				});
			}
		}

		return sourceMap;
	});
	const teleportSourceMap = computed(() => {
		const doc = textDocumentForTemplate.value ?? textDocument.value;
		if (generate.value && doc) {
			const sourceMap = new TeleportSourceMap(doc);
			for (const teleport of generate.value.teleports) {
				sourceMap.add(teleport);
			}
			return sourceMap;
		}
	});

	return {
		scriptSetupAst,
		textDocument,
		textDocumentForSuggestion,
		textDocumentForTemplate,
		sourceMap,
		sourceMapForSuggestion,
		sourceMapForTemplate,
		teleportSourceMap,
	};
}

function useScriptAst(
	script: Ref<null | {
		content: string,
	}>,
) {
	return computed(() => {
		if (!script.value) return;

		const ts = getTypescript();
		let exportDefault: {
			start: number,
			end: number,
			args: {
				text: string,
				start: number,
				end: number,
			},
		} | undefined;

		const scriptAst = ts.createSourceFile('', script.value.content, ts.ScriptTarget.Latest);
		scriptAst.forEachChild(node => {
			if (ts.isExportAssignment(node)) {
				let obj: ts.ObjectLiteralExpression | undefined;
				if (ts.isObjectLiteralExpression(node.expression)) {
					obj = node.expression;
				}
				else if (ts.isCallExpression(node.expression) && node.expression.arguments.length) {
					const arg0 = node.expression.arguments[0];
					if (ts.isObjectLiteralExpression(arg0)) {
						obj = arg0;
					}
				}
				if (obj) {
					exportDefault = {
						...getStartEnd(node),
						args: {
							text: obj.getText(scriptAst),
							...getStartEnd(obj),
						},
					};
				}
			}
		});

		return {
			exportDefault,
		};

		function getStartEnd(node: ts.Node) {
			// TODO: high cost
			const start = node.getStart(scriptAst);
			const end = node.getEnd();
			return {
				start: start,
				end: end,
			};
		}
	});
}
function useScriptSetupAst(
	scriptSetup: Ref<null | {
		content: string,
	}>,
) {
	return computed(() => {
		if (!scriptSetup.value) return;

		const ts = getTypescript();
		const labels: {
			start: number,
			end: number,
			binarys: {
				parent: {
					start: number,
					end: number,
				},
				vars: {
					isShortand: boolean,
					inRoot: boolean,
					text: string,
					start: number,
					end: number,
				}[],
				left: {
					start: number,
					end: number,
				},
				right?: {
					start: number,
					end: number,
					isComputedCall: boolean,
				},
			}[],
			label: {
				start: number,
				end: number,
			},
			parent: {
				start: number,
				end: number,
			},
		}[] = [];
		const exposeVarNames: {
			start: number,
			end: number,
		}[] = [];
		const imports: {
			start: number,
			end: number,
		}[] = [];
		let defineProps: {
			start: number,
			end: number,
			args?: {
				start: number,
				end: number,
			},
			typeArgs?: {
				start: number,
				end: number,
			},
		} | undefined;
		let defineEmit: typeof defineProps;
		const refCalls: {
			start: number,
			end: number,
			vars: {
				start: number,
				end: number,
			}[],
			left: {
				start: number,
				end: number,
			},
			rightExpression: {
				start: number,
				end: number,
			},
		}[] = [];
		const shorthandPropertys: {
			start: number,
			end: number,
		}[] = [];
		const dollars: number[] = [];

		const scriptAst = ts.createSourceFile('', scriptSetup.value.content, ts.ScriptTarget.Latest);

		scriptAst.forEachChild(node => {
			if (ts.isVariableStatement(node)) {
				for (const node_2 of node.declarationList.declarations) {
					const vars = findBindingVars(node_2.name);
					for (const _var of vars) {
						exposeVarNames.push(_var);
					}
				}
			}
			else if (ts.isFunctionDeclaration(node)) {
				if (node.name && ts.isIdentifier(node.name)) {
					exposeVarNames.push(getStartEnd(node.name));
				}
			}
			else if (ts.isImportDeclaration(node)) {
				imports.push(getStartEnd(node));
				if (node.importClause && !node.importClause.isTypeOnly) {
					if (node.importClause.name) {
						exposeVarNames.push(getStartEnd(node.importClause.name));
					}
					if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
						for (const element of node.importClause.namedBindings.elements) {
							exposeVarNames.push(getStartEnd(element.name));
						}
					}
				}
			}
		});
		scriptAst.forEachChild(node => {
			deepLoop(node, scriptAst, true);
		});

		let noLabelCode = scriptSetup.value.content;
		for (const label of labels) {
			noLabelCode = noLabelCode.substring(0, label.label.start) + 'let' + noLabelCode.substring(label.label.end).replace(':', ' ');
			for (const binary of label.binarys) {
				if (binary.parent.start !== binary.left.start) {
					noLabelCode = replaceStringToEmpty(noLabelCode, binary.parent.start, binary.left.start);
				}
				if (binary.parent.end !== binary.left.end) {
					noLabelCode = replaceStringToEmpty(noLabelCode, (binary.right ?? binary.left).end, binary.parent.end);
				}
			}
		}

		return {
			labels,
			exposeVarNames,
			imports,
			defineProps,
			defineEmit,
			refCalls,
			shorthandPropertys,
			dollars,
		};

		function getStartEnd(node: ts.Node) {
			// TODO: high cost
			const start = node.getStart(scriptAst);
			const end = node.getEnd();
			return {
				start: start,
				end: end,
			};
		}
		function deepLoop(node: ts.Node, parent: ts.Node, inRoot: boolean) {
			if (
				ts.isIdentifier(node)
				&& node.getText(scriptAst).startsWith('$')
			) {
				dollars.push(node.getStart(scriptAst));
			}
			if (
				ts.isLabeledStatement(node)
				&& node.label.getText(scriptAst) === 'ref'
				&& ts.isExpressionStatement(node.statement)
			) {
				labels.push({
					...getStartEnd(node),
					label: getStartEnd(node.label),
					parent: getStartEnd(parent),
					binarys: findBinaryExpressions(node.statement.expression, inRoot),
				});
			}
			else if (
				ts.isCallExpression(node)
				&& ts.isIdentifier(node.expression)
				&& (
					node.expression.getText(scriptAst) === 'defineProps'
					|| node.expression.getText(scriptAst) === 'defineEmit'
				)
			) {
				// TODO: handle this
				// import * as vue from 'vue'
				// const props = vue.defineProps...
				const arg: ts.Expression | undefined = node.arguments.length ? node.arguments[0] : undefined;
				const typeArg: ts.TypeNode | undefined = node.typeArguments?.length ? node.typeArguments[0] : undefined;
				const call = {
					...getStartEnd(node),
					args: arg ? getStartEnd(arg) : undefined,
					typeArgs: typeArg ? getStartEnd(typeArg) : undefined,
				};
				if (node.expression.getText(scriptAst) === 'defineProps') {
					defineProps = call;
				}
				else if (node.expression.getText(scriptAst) === 'defineEmit') {
					defineEmit = call;
				}
			}
			else if (
				ts.isVariableDeclarationList(node)
				&& node.declarations.length === 1
				&& node.declarations[0].initializer
				&& ts.isCallExpression(node.declarations[0].initializer)
				&& ts.isIdentifier(node.declarations[0].initializer.expression)
				&& ['ref', 'computed'].includes(node.declarations[0].initializer.expression.getText(scriptAst))
			) {
				const declaration = node.declarations[0];
				const refCall = node.declarations[0].initializer;
				const isRef = refCall.expression.getText(scriptAst) === 'ref';
				const wrapContant = isRef && refCall.arguments.length === 1 ? refCall.arguments[0] : refCall;
				refCalls.push({
					...getStartEnd(node),
					vars: findBindingVars(declaration.name),
					left: getStartEnd(declaration.name),
					rightExpression: getStartEnd(wrapContant),
				});
			}
			else if (ts.isShorthandPropertyAssignment(node)) {
				shorthandPropertys.push(getStartEnd(node));
			}
			node.forEachChild(child => deepLoop(child, node, false));
		}
		function findBinaryExpressions(exp: ts.Expression, inRoot: boolean) {
			const binaryExps: typeof labels[0]['binarys'] = [];
			worker(exp);
			return binaryExps;
			function worker(node: ts.Expression, parenthesized?: ts.ParenthesizedExpression) {
				if (ts.isIdentifier(node)) {
					const range = getStartEnd(node);
					binaryExps.push({
						vars: findLabelVars(node, inRoot),
						left: range,
						parent: range,
					});
				}
				if (ts.isBinaryExpression(node)) {
					if (ts.isBinaryExpression(node.left) || ts.isBinaryExpression(node.right) || ts.isParenthesizedExpression(node.left) || ts.isParenthesizedExpression(node.right)) {
						worker(node.left);
						worker(node.right);
					}
					else {
						let parent: ts.Node = parenthesized ?? node;
						binaryExps.push({
							vars: findLabelVars(node.left, inRoot),
							left: getStartEnd(node.left),
							right: {
								...getStartEnd(node.right),
								isComputedCall: ts.isCallExpression(node.right) && ts.isIdentifier(node.right.expression) && node.right.expression.getText(scriptAst) === 'computed'
							},
							parent: getStartEnd(parent),
						});
					}
				}
				else if (ts.isParenthesizedExpression(node)) {
					// unwrap (...)
					worker(node.expression, parenthesized ?? node);
				}
			}
		}
		function findLabelVars(exp: ts.Expression, inRoot: boolean) {
			const vars: typeof labels[0]['binarys'][0]['vars'] = [];
			worker(exp);
			return vars;
			function worker(_node: ts.Node) {
				if (ts.isIdentifier(_node)) {
					vars.push({
						isShortand: false,
						inRoot,
						text: _node.getText(scriptAst), // TODO: remove
						...getStartEnd(_node),
					});
				}
				// { ? } = ...
				else if (ts.isObjectLiteralExpression(_node)) {
					for (const property of _node.properties) {
						worker(property);
					}
				}
				// [ ? ] = ...
				else if (ts.isArrayLiteralExpression(_node)) {
					for (const property of _node.elements) {
						worker(property);
					}
				}
				// { foo: ? } = ...
				else if (ts.isPropertyAssignment(_node)) {
					worker(_node.initializer);
				}
				// { e: f = 2 } = ...
				else if (ts.isBinaryExpression(_node) && ts.isIdentifier(_node.left)) {
					worker(_node.left);
				}
				// { foo } = ...
				else if (ts.isShorthandPropertyAssignment(_node)) {
					vars.push({
						isShortand: true,
						inRoot,
						text: _node.name.getText(scriptAst), // TODO: remove
						...getStartEnd(_node.name),
					});
				}
				// { ...? } = ...
				// [ ...? ] = ...
				else if (ts.isSpreadAssignment(_node) || ts.isSpreadElement(_node)) {
					worker(_node.expression);
				}
			}
		}
		function findBindingVars(left: ts.BindingName) {
			const vars: MapedRange[] = [];
			worker(left);
			return vars;
			function worker(_node: ts.Node) {
				if (ts.isIdentifier(_node)) {
					vars.push(getStartEnd(_node));
				}
				// { ? } = ...
				// [ ? ] = ...
				else if (ts.isObjectBindingPattern(_node) || ts.isArrayBindingPattern(_node)) {
					for (const property of _node.elements) {
						if (ts.isBindingElement(property)) {
							worker(property.name);
						}
					}
				}
				// { foo: ? } = ...
				else if (ts.isPropertyAssignment(_node)) {
					worker(_node.initializer);
				}
				// { foo } = ...
				else if (ts.isShorthandPropertyAssignment(_node)) {
					vars.push(getStartEnd(_node.name));
				}
				// { ...? } = ...
				// [ ...? ] = ...
				else if (ts.isSpreadAssignment(_node) || ts.isSpreadElement(_node)) {
					worker(_node.expression);
				}
			}
		}
	});
}
function useGenerate(
	script: Ref<null | {
		src?: string,
		content: string,
	}>,
	scriptSetup: Ref<null | {
		content: string,
	}>,
	scriptAst: ReturnType<typeof useScriptAst>,
	scriptSetupAst: ReturnType<typeof useScriptSetupAst>,
) {
	return computed(() => {

		const gen = createScriptGenerator();
		const teleports: Mapping<TeleportMappingData>[] = [];

		writeScriptSrc();
		writeScript();
		writeScriptSetup();
		writeExportOptions();

		return {
			code: gen.getText(),
			mappings: gen.getMappings(),
			teleports,
		};

		function writeScriptSrc() {
			if (script.value?.src) {
				gen.addText(`export * from `);
				gen.addCode(
					`'${script.value.src}'`,
					{ start: -1, end: -1 },
					MapedMode.Offset,
					{
						vueTag: 'scriptSrc',
						capabilities: {
							basic: true,
							references: true,
							definitions: true,
							rename: true,
							diagnostic: true,
							formatting: true,
							completion: true,
							semanticTokens: true,
							foldingRanges: true,
						},
					}
				);
				gen.addText(`;\n`);
				gen.addText(`import __VLS_ScriptSrc from '${script.value.src}';\n`);
				gen.addText(`export default __VLS_ScriptSrc;\n`);
			}
		}
		function writeScript() {
			if (script.value) {
				let addText = script.value.content;
				if (scriptSetup.value && scriptAst.value?.exportDefault) {
					addText = replaceStringToEmpty(script.value.content, scriptAst.value.exportDefault.start, scriptAst.value.exportDefault.end);
				}
				gen.addCode(
					addText,
					{ start: 0, end: addText.length },
					MapedMode.Offset,
					{
						vueTag: 'script',
						capabilities: {
							basic: true,
							references: true,
							definitions: true,
							rename: true,
							diagnostic: true,
							formatting: true,
							completion: true,
							semanticTokens: true,
							foldingRanges: true,
						},
					}
				);
			}
		}
		function writeScriptSetup() {
			if (!scriptSetup.value) {
				return;
			}
			if (!scriptSetupAst.value) {
				return;
			}
			const data = scriptSetupAst.value;
			const originalCode = scriptSetup.value.content;
			let sourceCode = scriptSetup.value.content;
			gen.addText(`\n/* <script setup> */\n`);
			let newLinesOnly = originalCode.split('\n').map(line => ' '.repeat(line.length)).join('\n');
			let importPos = 0;
			for (const _import of data.imports.sort((a, b) => a.start - b.start)) {
				gen.addCode(
					newLinesOnly.substring(importPos, _import.start),
					{ start: importPos, end: _import.start },
					MapedMode.Offset,
					{ // for auto import
						vueTag: 'scriptSetup',
						capabilities: {},
					},
				);
				gen.addCode(
					originalCode.substring(_import.start, _import.end),
					{ start: _import.start, end: _import.end },
					MapedMode.Offset,
					{
						vueTag: 'scriptSetup',
						capabilities: {
							basic: true,
							references: true,
							definitions: true,
							rename: true,
							semanticTokens: true,
							completion: true,
							diagnostic: true,
						},
					},
				);
				sourceCode = replaceStringToEmpty(sourceCode, _import.start, _import.end);
				importPos = _import.end;
			}
			gen.addCode(
				newLinesOnly.substring(importPos, newLinesOnly.length),
				{ start: importPos, end: newLinesOnly.length },
				MapedMode.Offset,
				{ // for auto import
					vueTag: 'scriptSetup',
					capabilities: {},
				},
			);

			gen.addText(`\n`);
			gen.addText(`export default (await import('__VLS_vue')).defineComponent({\n`);
			if (data.defineProps?.typeArgs) {
				gen.addText(`props: ({} as __VLS_DefinePropsToOptions<`);
				gen.addCode(
					originalCode.substring(data.defineProps.typeArgs.start, data.defineProps.typeArgs.end),
					{
						start: data.defineProps.typeArgs.start,
						end: data.defineProps.typeArgs.end,
					},
					MapedMode.Offset,
					{
						vueTag: 'scriptSetup',
						capabilities: {},
					},
				);
				gen.addText(`>),\n`);
			}
			if (data.defineEmit?.typeArgs) {
				gen.addText(`emits: ({} as __VLS_ConstructorOverloads<`);
				gen.addCode(
					originalCode.substring(data.defineEmit.typeArgs.start, data.defineEmit.typeArgs.end),
					{
						start: data.defineEmit.typeArgs.start,
						end: data.defineEmit.typeArgs.end,
					},
					MapedMode.Offset,
					{
						vueTag: 'scriptSetup',
						capabilities: {},
					},
				);
				gen.addText(`>),\n`);
			}
			if (data.defineProps?.args) {
				gen.addText(`props: `);
				gen.addCode(
					originalCode.substring(data.defineProps.args.start, data.defineProps.args.end),
					{
						start: data.defineProps.args.start,
						end: data.defineProps.args.end,
					},
					MapedMode.Offset,
					{
						vueTag: 'scriptSetup',
						capabilities: {
							basic: true,
							references: true,
							definitions: true,
							diagnostic: true,
							rename: true,
							completion: true,
							semanticTokens: true,
						},
					},
				);
				gen.addText(`,\n`);
			}
			if (data.defineEmit?.args) {
				gen.addText(`emits: `);
				gen.addCode(
					originalCode.substring(data.defineEmit.args.start, data.defineEmit.args.end),
					{
						start: data.defineEmit.args.start,
						end: data.defineEmit.args.end,
					},
					MapedMode.Offset,
					{
						vueTag: 'scriptSetup',
						capabilities: {
							basic: true,
							references: true,
							definitions: true,
							diagnostic: true,
							rename: true,
							completion: true,
							semanticTokens: true,
						},
					},
				);
				gen.addText(`,\n`);
			}
			gen.addText(`async `);
			gen.addCode(
				'setup',
				{
					start: 0,
					end: 0,
				},
				MapedMode.Gate,
				{
					vueTag: 'scriptSetup',
					capabilities: {},
				});
			gen.addText(`() {\n`);

			const labels = data.labels.sort((a, b) => a.start - b.start);
			let tsOffset = 0;
			for (const label of labels) {
				mapSubText(tsOffset, label.start);
				let first = true;

				gen.addText(`{ `);
				for (const binary of label.binarys) {
					if (first) {
						first = false;
						gen.addText(`let `);
					}
					else {
						gen.addText(`, `);
					}
					for (const v of binary.vars) {
						(v as any)['teleportRange'] = {
							start: gen.getText().length + v.start - binary.left.start,
							end: gen.getText().length + v.end - binary.left.start,
						};
					}
					gen.addCode(
						originalCode.substring(binary.left.start, binary.left.end),
						binary.left,
						MapedMode.Offset,
						{
							vueTag: 'scriptSetup',
							capabilities: {
								completion: true,
								definitions: true,
								semanticTokens: true,
								rename: true,
							},
						},
					);
					if (binary.right) {
						gen.addText(` = `);
						gen.addText(originalCode.substring(binary.right.start, binary.right.end));
					}
				}
				gen.addText(`; }\n`);

				first = true;
				for (const binary of label.binarys) {
					if (first) {
						first = false;
						gen.addText(`const `);
					}
					else {
						gen.addText(`, `);
					}

					let leftPos = binary.left.start;
					for (const prop of binary.vars.sort((a, b) => a.start - b.start)) {
						gen.addText(originalCode.substring(leftPos, prop.start));
						if (prop.isShortand) {
							gen.addCode(
								prop.text,
								prop,
								MapedMode.Offset,
								{
									vueTag: 'scriptSetup',
									capabilities: {
										diagnostic: true,
									},
								},
							);
							gen.addText(`: `);
						}
						gen.addCode(
							`__VLS_refs_${prop.text}`,
							prop,
							MapedMode.Gate,
							{
								vueTag: 'scriptSetup',
								capabilities: {
									diagnostic: true,
								},
							},
						);
						leftPos = prop.end;
					}
					gen.addText(originalCode.substring(leftPos, binary.left.end));

					if (binary.right) {
						gen.addText(` = `);
						mapSubText(binary.right.start, binary.right.end);
					}
				}
				gen.addText(`;\n`);

				for (const binary of label.binarys) {
					for (const prop of binary.vars) {
						gen.addText(`let `);
						const refVarRange = gen.addCode(
							prop.text,
							{
								start: prop.start,
								end: prop.end,
							},
							MapedMode.Offset,
							{
								vueTag: 'scriptSetup',
								capabilities: {
									basic: true, // hover
									references: true,
									diagnostic: true,
								},
							},
						);
						gen.addText(` = (await import('__VLS_vue')).unref(`);
						if (binary.right) {
							gen.addCode(
								`__VLS_refs_${prop.text}`,
								binary.right,
								MapedMode.Offset, // TODO
								{
									vueTag: 'scriptSetup',
									capabilities: {},
								},
							);
						}
						else {
							gen.addText(`__VLS_refs_${prop.text}`);
						}
						gen.addText(`); ${prop.text};\n`);

						gen.addText(`const `);
						const dollarRefVarRange = gen.addCode(
							'$' + prop.text,
							{
								start: prop.start,
								end: prop.end,
							},
							MapedMode.Offset, // TODO
							{
								vueTag: 'scriptSetup',
								beforeRename: newName => newName.startsWith('$') ? newName.substr(1) : newName, // remove $
								doRename: (oldName, newName) => '$1' + newName,
								capabilities: {
									basic: true, // hover
									diagnostic: true,
								},
							},
						);
						gen.addText(` = (await import('__VLS_vue')).ref(`);
						if (binary.right) {
							gen.addCode(
								`__VLS_refs_${prop.text}`,
								binary.right,
								MapedMode.Offset, // TODO
								{
									vueTag: 'scriptSetup',
									capabilities: {},
								},
							);
						}
						else {
							gen.addText(`__VLS_refs_${prop.text}`);
						}
						gen.addText(`); $${prop.text};\n`);

						teleports.push({
							mode: MapedMode.Offset,
							sourceRange: (prop as any)['teleportRange'],
							targetRange: refVarRange,
							data: {
								direction: 'sibling',
								capabilities: {
									references: true,
									rename: true,
								},
							},
						});
						teleports.push({
							mode: MapedMode.Gate,
							sourceRange: refVarRange,
							targetRange: dollarRefVarRange,
							others: [
								{
									mode: MapedMode.Offset,
									sourceRange: refVarRange,
									targetRange: {
										start: dollarRefVarRange.start + 1, // remove $
										end: dollarRefVarRange.end,
									},
								},
							],
							data: {
								editRenameTextToTarget: newName => '$' + newName,
								editRenameTextToSource: newName => newName.startsWith('$') ? newName.substr(1) : newName,
								direction: 'sibling',
								capabilities: {
									references: true,
									rename: true,
								},
							},
						});
					}
				}

				tsOffset = label.end;
			}
			mapSubText(tsOffset, sourceCode.length);

			gen.addText(`return {\n`);
			for (const expose of data.exposeVarNames) {
				const varName = originalCode.substring(expose.start, expose.end);
				// TODO: remove this
				const templateSideRange = gen.addCode(
					varName,
					{
						start: expose.start,
						end: expose.end,
					},
					MapedMode.Offset,
					{
						vueTag: 'scriptSetup',
						capabilities: {},
					},
				);
				gen.addText(': ');
				// TODO: remove this
				const scriptSideRange = gen.addCode(
					varName,
					{
						start: expose.start,
						end: expose.end,
					},
					MapedMode.Offset,
					{
						vueTag: 'scriptSetup',
						capabilities: {},
					},
				);
				gen.addText(',\n');

				teleports.push({
					sourceRange: scriptSideRange,
					targetRange: templateSideRange,
					mode: MapedMode.Offset,
					data: {
						direction: 'scriptToTemplate',
						capabilities: {
							definitions: true,
							references: true,
							rename: true,
						},
					},
				});
			}
			for (const label of data.labels) {
				for (const binary of label.binarys) {
					for (const refVar of binary.vars) {
						if (refVar.inRoot) {
							// TODO: remove this
							const templateSideRange = gen.addCode(
								refVar.text,
								{
									start: refVar.start,
									end: refVar.end,
								},
								MapedMode.Offset,
								{
									vueTag: 'scriptSetup',
									capabilities: {},
								},
							);
							gen.addText(': ');
							// TODO: remove this
							const scriptSideRange = gen.addCode(
								refVar.text,
								{
									start: refVar.start,
									end: refVar.end,
								},
								MapedMode.Offset,
								{
									vueTag: 'scriptSetup',
									capabilities: {},
								},
							);
							gen.addText(', \n');

							teleports.push({
								sourceRange: scriptSideRange,
								targetRange: templateSideRange,
								mode: MapedMode.Offset,
								data: {
									direction: 'scriptToTemplate',
									capabilities: {
										definitions: true,
										references: true,
										rename: true,
									},
								},
							});
						}
					}
				}
			}
			gen.addText(`};\n`);
			gen.addText(`}});\n`);

			gen.addText(`\n// @ts-ignore\n`);
			gen.addText(`ref${SearchTexts.Ref}\n`); // for execute auto import

			function mapSubText(start: number, end: number) {
				gen.addCode(
					sourceCode.substring(start, end),
					{
						start,
						end,
					},
					MapedMode.Offset,
					{
						vueTag: 'scriptSetup',
						capabilities: {
							basic: true,
							references: true,
							definitions: true,
							diagnostic: true,
							rename: true,
							completion: true,
							semanticTokens: true,
						},
					},
				);
			}
		}
		function writeExportOptions() {
			gen.addText(`\n`);
			gen.addText(`export const __VLS_options = {\n`);
			gen.addText(`...(`);
			const defaultExport = scriptAst.value?.exportDefault?.args;
			if (defaultExport) {
				gen.addCode(
					defaultExport.text,
					defaultExport,
					MapedMode.Offset,
					{
						vueTag: 'script',
						capabilities: {
							references: true,
							definitions: true,
							rename: true,
						},
					},
				);
			}
			else {
				gen.addText(`{}`);
			}
			gen.addText(`),\n`);
			if (scriptSetupAst.value?.defineProps?.args && scriptSetup.value) {
				gen.addText(`props: (`);
				gen.addCode(
					scriptSetup.value.content.substring(scriptSetupAst.value.defineProps.args.start, scriptSetupAst.value.defineProps.args.end),
					scriptSetupAst.value.defineProps.args,
					MapedMode.Offset,
					{
						vueTag: 'scriptSetup',
						capabilities: {
							references: true,
							definitions: true,
							rename: true,
						},
					},
				);
				gen.addText(`),\n`);
			}
			if (scriptSetupAst.value?.defineProps?.typeArgs && scriptSetup.value) {
				gen.addText(`props: ({} as `);
				gen.addCode(
					scriptSetup.value.content.substring(scriptSetupAst.value.defineProps.typeArgs.start, scriptSetupAst.value.defineProps.typeArgs.end),
					scriptSetupAst.value.defineProps.typeArgs,
					MapedMode.Offset,
					{
						vueTag: 'scriptSetup',
						capabilities: {
							references: true,
							definitions: true,
							rename: true,
						},
					},
				);
				gen.addText(`),\n`);
			}
			if (scriptSetupAst.value?.defineEmit?.args && scriptSetup.value) {
				gen.addText(`emits: (`);
				gen.addCode(
					scriptSetup.value.content.substring(scriptSetupAst.value.defineEmit.args.start, scriptSetupAst.value.defineEmit.args.end),
					scriptSetupAst.value.defineEmit.args,
					MapedMode.Offset,
					{
						vueTag: 'scriptSetup',
						capabilities: {
							references: true,
							definitions: true,
							rename: true,
						},
					},
				);
				gen.addText(`),\n`);
			}
			gen.addText(`};\n`);
		}
	});
}
function useGenerateForSuggestion(
	script: Ref<null | {
		content: string,
	}>,
	scriptSetup: Ref<null | {
		content: string,
	}>,
	scriptSetupAst: ReturnType<typeof useScriptSetupAst>,
	html: Ref<string | undefined>,
) {
	return computed(() => {
		if (!scriptSetup.value) return;

		const gen = createScriptGenerator();

		if (script.value) {
			gen.addCode(
				script.value.content,
				{ start: 0, end: script.value.content.length },
				MapedMode.Offset,
				{
					vueTag: 'script',
					capabilities: {
						diagnostic: true,
					},
				},
			);
			gen.addText('\n');
		}
		if (scriptSetup.value && scriptSetupAst.value) {
			let noDollarCode = scriptSetup.value.content;
			for (const dollar of scriptSetupAst.value.dollars) {
				noDollarCode = noDollarCode.substring(0, dollar) + ' ' + noDollarCode.substring(dollar + 1); // replace '$'
			}
			for (const label of scriptSetupAst.value.labels) {
				noDollarCode = noDollarCode.substring(0, label.label.start) + 'let' + noDollarCode.substring(label.label.end).replace(':', ' '); // replace 'ref:'
				if (label.binarys.length) {
					const start = label.binarys[0];
					const end = label.binarys[label.binarys.length - 1];
					if (start.parent.start !== start.left.start) {
						noDollarCode = noDollarCode.substring(0, start.parent.start) + ' '.repeat(start.left.start - start.parent.start) + noDollarCode.substring(start.left.start); // replace '('
					}
					const endOffset = (end.right ?? end.left).end;
					if (end.parent.end !== endOffset) {
						noDollarCode = noDollarCode.substring(0, endOffset) + ' '.repeat(end.parent.end - endOffset) + noDollarCode.substring(end.parent.end); // replace ')'
					}
				}
			}
			gen.addCode(
				noDollarCode,
				{ start: 0, end: noDollarCode.length },
				MapedMode.Offset,
				{
					vueTag: 'scriptSetup',
					capabilities: {
						diagnostic: true,
					},
				},
			);

			if (html.value) {
				const interpolations = transformVueHtml(html.value, [], [], undefined, scriptSetupAst.value.exposeVarNames.map(range => scriptSetup.value?.content.substring(range.start, range.end) ?? ''), false);
				gen.addText('{\n');
				gen.addText(interpolations.text);
				gen.addText('}\n');
			}
		}

		return {
			code: gen.getText(),
			mappings: gen.getMappings(),
		}
	});
}
function replaceStringToEmpty(str: string, start: number, end: number) {
	if (Math.abs(end - start) >= 4) {
		return str.substring(0, start) + '/*' + ' '.repeat(Math.abs(end - start) - 4) + '*/' + str.substring(end);
	}
	return str.substring(0, start) + ' '.repeat(Math.abs(end - start)) + str.substring(end);
}
