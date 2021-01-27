import { MapedMode, TsMappingData, MapedRange, createScriptGenerator } from './sourceMaps';
import { camelize, hyphenate } from '@vue/shared';
import * as vueDom from '@vue/compiler-dom';
import { NodeTypes, transformOn } from '@vue/compiler-dom';
import type { TemplateChildNode, ElementNode, RootNode, TransformContext } from '@vue/compiler-dom';

const capabilitiesSet = {
	all: { basic: true, diagnostic: true, references: true, definitions: true, rename: true, completion: true, semanticTokens: true },
	noFormatting: { basic: true, diagnostic: true, references: true, definitions: true, rename: true, completion: true, semanticTokens: true },
	diagnosticOnly: { diagnostic: true, completion: true, },
	htmlTagOrAttr: { basic: true, diagnostic: true, references: true, definitions: true, rename: true, },
	className: { basic: true, references: true, definitions: true, rename: true, },
	slotName: { basic: true, diagnostic: true, references: true, definitions: true, },
	slotNameExport: { basic: true, diagnostic: true, references: true, definitions: true, referencesCodeLens: true },
	propRaw: { references: true, definitions: true, rename: true, },
	referencesOnly: { references: true, definitions: true, },
}

export function transformVueHtml(
	html: string,
	componentNames: string[] = [],
	cssScopedClasses: string[] = [],
	htmlToTemplate?: (htmlStart: number, htmlEnd: number) => number | undefined,
	scriptSetupVars?: string[],
	withExportSlots = true,
) {
	let node: vueDom.RootNode;
	try {
		node = vueDom.compile(html, { onError: () => { } }).ast;
	}
	catch {
		return {
			textWithoutSlots: '',
			text: '',
			mappings: [],
			cssCode: '',
			cssMappings: [],
			tags: new Set<string>(),
			formatCode: '',
			formapMappings: [],
		};
	}
	const scriptGen = createScriptGenerator();
	const formatGen = createScriptGenerator();
	const inlineCssGen = createScriptGenerator<undefined>();
	const tags = new Set<string>();
	const slots = new Map<string, {
		varName: string,
		loc: MapedRange,
	}>();
	const componentsMap = new Map<string, string>();
	const cssScopedClassesSet = new Set(cssScopedClasses);

	for (const componentName of componentNames) {
		componentsMap.set(hyphenate(componentName), componentName);
	}

	let elementIndex = 0;
	writeNode(node, []);

	if (withExportSlots) {
		scriptGen.addText(`export default {\n`);
		for (const [name, slot] of slots) {
			writeObjectProperty(false, name, capabilitiesSet.slotNameExport, slot.loc);
			scriptGen.addText(`: ${slot.varName},\n`);
		}
		scriptGen.addText(`};\n`);
	}

	return {
		text: scriptGen.getText(),
		mappings: scriptGen.getMappings(),
		formatCode: formatGen.getText(),
		formapMappings: formatGen.getMappings(),
		cssMappings: inlineCssGen.getMappings(),
		cssCode: inlineCssGen.getText(),
		tags,
	};

	function getComponentName(tagName: string) {
		return componentsMap.get(tagName) ?? tagName;
	}
	function writeNode(node: TemplateChildNode | RootNode, parents: (TemplateChildNode | RootNode)[]): void {
		if (node.type === NodeTypes.ROOT) {
			for (const childNode of node.children) {
				scriptGen.addText(`{\n`);
				writeNode(childNode, parents.concat(node));
				scriptGen.addText(`}\n`);
			}
		}
		else if (node.type === NodeTypes.ELEMENT) {
			scriptGen.addText(`{\n`);
			{
				tags.add(getComponentName(node.tag));

				if (scriptSetupVars) {
					for (const scriptSetupVar of scriptSetupVars) {
						if (node.tag === scriptSetupVar || node.tag === hyphenate(scriptSetupVar)) {
							scriptGen.addText(scriptSetupVar + `; // ignore unused in script setup\n`);
						}
					}
				}

				writeInlineCss(node);
				writeImportSlots(node);
				writeVshow(node);
				writeElReferences(node); // <el ref="foo" />
				writeProps(node, false);
				writeProps(node, true);
				writeClassScopeds(node);
				writeOns(node);
				writeOptionReferences(node);
				writeSlots(node);

				for (const childNode of node.children) {
					writeNode(childNode, parents.concat(node));
				}
			}
			scriptGen.addText('}\n');

			function writeInlineCss(node: ElementNode) {
				for (const prop of node.props) {
					if (
						prop.type === NodeTypes.DIRECTIVE
						&& prop.name === 'bind'
						&& prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION
						&& prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION
						&& prop.arg.content === 'style'
						&& prop.exp.constType === vueDom.ConstantTypes.CAN_STRINGIFY
					) {
						const endCrt = prop.arg.loc.source[prop.arg.loc.source.length - 1]; // " | '
						const start = prop.arg.loc.source.indexOf(endCrt) + 1;
						const end = prop.arg.loc.source.lastIndexOf(endCrt);
						const content = prop.arg.loc.source.substring(start, end);
						const sourceRange = {
							start: prop.arg.loc.start.offset + start,
							end: prop.arg.loc.start.offset + end,
						};
						if (htmlToTemplate) {
							const newStart = htmlToTemplate(sourceRange.start, sourceRange.end);
							if (newStart === undefined) continue;
							const offset = newStart - sourceRange.start;
							sourceRange.start += offset;
							sourceRange.end += offset;
						}
						inlineCssGen.addText(`${node.tag} { `);
						inlineCssGen.addCode(
							content,
							sourceRange,
							MapedMode.Offset,
							undefined,
						);
						inlineCssGen.addText(content);
						inlineCssGen.addText(` }\n`);
					}
				}
			}
			function writeImportSlots(node: ElementNode) {
				for (const prop of node.props) {
					if (
						prop.type === NodeTypes.DIRECTIVE
						&& prop.name === 'slot'
					) {
						const parent = findParentElement(parents.concat(node));
						if (!parent) continue;

						if (prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION) {
							scriptGen.addText(`let `);
							writeCode(false, prop.exp.content, MapedMode.Offset, capabilitiesSet.all, {
								start: prop.exp.loc.start.offset,
								end: prop.exp.loc.end.offset,
							}, true, ['(', ')']);
							scriptGen.addText(` = `);
						}
						let slotName = 'default';
						if (prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.content !== '') {
							slotName = prop.arg.content;
						}
						const diagStart = scriptGen.getText().length;
						scriptGen.addText(`__VLS_components['${getComponentName(parent.tag)}'].__VLS_slots`);
						writePropertyAccess(false, slotName, capabilitiesSet.slotName, {
							start: prop.arg?.loc.start.offset ?? prop.loc.start.offset,
							end: prop.arg?.loc.end.offset ?? prop.loc.end.offset,
						});
						const diagEnd = scriptGen.getText().length;
						scriptGen.addMapping2(
							{
								start: diagStart,
								end: diagEnd,
							},
							{
								start: prop.arg?.loc.start.offset ?? prop.loc.start.offset,
								end: prop.arg?.loc.end.offset ?? prop.loc.end.offset,
							},
							MapedMode.Gate,
							{
								vueTag: 'template',
								capabilities: capabilitiesSet.diagnosticOnly,
							},
						);
						scriptGen.addText(`;\n`);
					}

					function findParentElement(parents: (TemplateChildNode | RootNode)[]): ElementNode | undefined {
						for (const parent of parents.reverse()) {
							if (parent.type === NodeTypes.ELEMENT && parent.tag !== 'template') {
								return parent;
							}
						}
					}
				}
			}
			function writeOptionReferences(node: ElementNode) {
				// fix find references not work if prop has default value
				// fix emits references not work
				for (const prop of node.props) {
					if (
						prop.type === NodeTypes.DIRECTIVE
						&& prop.arg
						&& (!prop.exp || prop.exp.type === NodeTypes.SIMPLE_EXPRESSION)
						&& prop.arg.type === NodeTypes.SIMPLE_EXPRESSION
						&& !(prop.exp?.constType === vueDom.ConstantTypes.CAN_STRINGIFY) // ignore style, style='z-index: 2' will compile to {'z-index':'2'}
					) {
						if (prop.name === 'bind' || prop.name === 'model') {
							write('props', prop.arg.content, prop.arg.loc.start.offset, prop.arg.loc.end.offset);
						}
						else if (prop.name === 'on') {
							write('emits', prop.arg.content, prop.arg.loc.start.offset, prop.arg.loc.end.offset);
						}
					}
					else if (
						prop.type === NodeTypes.ATTRIBUTE
					) {
						write('props', prop.name, prop.loc.start.offset, prop.loc.start.offset + prop.name.length);
					}
				}
				function write(option: 'props' | 'emits', propName: string, start: number, end: number) {
					const props = new Set<string>();
					const emits = new Set<string>();
					if (option === 'props') {
						props.add(propName);
						props.add(camelize(propName));
					}
					else if (option === 'emits') {
						emits.add(propName);
						props.add(camelize('on-' + propName));
					}
					for (const name of props.values()) {
						// __VLS_options.props
						scriptGen.addText(`// @ts-ignore\n`);
						scriptGen.addText(`__VLS_components['${getComponentName(node.tag)}'].__VLS_options.props`);
						writePropertyAccess(true, name, { ...capabilitiesSet.htmlTagOrAttr, basic: false }, {
							start,
							end,
						});
						scriptGen.addText(`;\n`);
					}
					for (const name of emits.values()) {
						// __VLS_options.emits
						scriptGen.addText(`// @ts-ignore\n`);
						scriptGen.addText(`__VLS_components['${getComponentName(node.tag)}'].__VLS_options.emits`);
						writePropertyAccess(false, name, { ...capabilitiesSet.htmlTagOrAttr, basic: false }, {
							start,
							end,
						});
						scriptGen.addText(`;\n`);
					}
				}
			}
			function writeVshow(node: ElementNode) {
				for (const prop of node.props) {
					if (
						prop.type === NodeTypes.DIRECTIVE
						&& !prop.arg
						&& prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION
					) {
						scriptGen.addText(`(`);
						writeCode(false, prop.exp.content, MapedMode.Offset, capabilitiesSet.all, {
							start: prop.exp.loc.start.offset,
							end: prop.exp.loc.end.offset,
						}, true, ['(', ')']);
						scriptGen.addText(`);\n`);
					}
				}
			}
			function writeElReferences(node: ElementNode) {
				for (const prop of node.props) {
					if (
						prop.type === NodeTypes.ATTRIBUTE
						&& prop.name === 'ref'
						&& prop.value
					) {
						scriptGen.addText(`// @ts-ignore\n`);
						scriptGen.addText(`(`);
						writeCode(false, prop.value.content, MapedMode.Offset, capabilitiesSet.referencesOnly, {
							start: prop.value.loc.start.offset + 1,
							end: prop.value.loc.end.offset - 1,
						});
						scriptGen.addText(`);\n`);
					}
				}
			}
			function writeProps(node: ElementNode, forDuplicateClassOrStyleAttr: boolean) {
				const varName = `__VLS_${elementIndex++}`;
				let wrap = false;

				if (!forDuplicateClassOrStyleAttr) {
					addStartWrap();
				}

				for (const prop of node.props) {
					if (
						prop.type === NodeTypes.DIRECTIVE
						&& prop.arg
						&& (!prop.exp || prop.exp.type === NodeTypes.SIMPLE_EXPRESSION)
						&& prop.arg.type === NodeTypes.SIMPLE_EXPRESSION
					) {
						if (forDuplicateClassOrStyleAttr) continue;

						if (!wrap) {
							addStartWrap();
						}

						const propName = hyphenate(prop.arg.content) === prop.arg.content ? camelize(prop.arg.content) : prop.arg.content;
						const propValue = prop.exp?.content ?? 'undefined';
						const propName2 = prop.arg.content;

						if (prop.name === 'bind' || prop.name === 'model') {
							// camelize name
							writeCode(false, `'${propName}': (${propValue})`, MapedMode.Gate, capabilitiesSet.diagnosticOnly, {
								start: prop.loc.start.offset,
								end: prop.loc.end.offset,
							}, false);
							if (prop.exp?.constType === vueDom.ConstantTypes.CAN_STRINGIFY) {
								writeObjectProperty(true, propName, capabilitiesSet.htmlTagOrAttr, {
									start: prop.arg.loc.start.offset,
									end: prop.arg.loc.start.offset + propName2.length, // patch style attr
								});
							}
							else {
								writeObjectProperty(true, propName, capabilitiesSet.htmlTagOrAttr, {
									start: prop.arg.loc.start.offset,
									end: prop.arg.loc.end.offset,
								});
							}
							scriptGen.addText(`: (`);
							if (prop.exp && !(prop.exp.constType === vueDom.ConstantTypes.CAN_STRINGIFY)) { // style='z-index: 2' will compile to {'z-index':'2'}
								writeCode(false, propValue, MapedMode.Offset, capabilitiesSet.all, {
									start: prop.exp.loc.start.offset,
									end: prop.exp.loc.end.offset,
								}, true, ['(', ')'])
							}
							else {
								scriptGen.addText(propValue);
							}
							scriptGen.addText(`),\n`);
							// original name
							if (propName2 !== propName) {
								writeObjectProperty(true, propName2, capabilitiesSet.htmlTagOrAttr, {
									start: prop.arg.loc.start.offset,
									end: prop.arg.loc.end.offset,
								});
								scriptGen.addText(`: (${propValue}),\n`);
							}
						}
					}
					else if (
						prop.type === NodeTypes.ATTRIBUTE
					) {
						const propName = hyphenate(prop.name) === prop.name ? camelize(prop.name) : prop.name;
						const propValue = prop.value !== undefined ? `\`${prop.value.content.replace(/`/g, '\\`')}\`` : 'true';
						const propName2 = prop.name;
						const isClassOrStyleAttr = ['style', 'class'].includes(propName);

						if (isClassOrStyleAttr !== forDuplicateClassOrStyleAttr) continue;

						if (!wrap) {
							addStartWrap();
						}

						// camelize name
						writeCode(false, `'${propName}': ${propValue}`, MapedMode.Gate, capabilitiesSet.diagnosticOnly, {
							start: prop.loc.start.offset,
							end: prop.loc.end.offset,
						}, false);
						writeObjectProperty(true, propName, capabilitiesSet.htmlTagOrAttr, {
							start: prop.loc.start.offset,
							end: prop.loc.start.offset + propName2.length,
						});
						scriptGen.addText(`: ${propValue},\n`);
						// original name
						if (propName2 !== propName) {
							writeObjectProperty(true, propName2, capabilitiesSet.htmlTagOrAttr, {
								start: prop.loc.start.offset,
								end: prop.loc.start.offset + propName2.length,
							});
							scriptGen.addText(`: ${propValue},\n`);
						}
					}
					else {
						scriptGen.addText("/* " + [prop.type, prop.name, prop.arg?.loc.source, prop.exp?.loc.source, prop.loc.source].join(", ") + " */\n");
					}
				}

				if (wrap) {
					addEndWrap();
				}

				function addStartWrap() {
					wrap = true;
					if (!forDuplicateClassOrStyleAttr) {
						{ // start tag
							scriptGen.addText(`__VLS_components`);
							writePropertyAccess(true, getComponentName(node.tag), capabilitiesSet.htmlTagOrAttr, {
								start: node.loc.start.offset + node.loc.source.indexOf(node.tag),
								end: node.loc.start.offset + node.loc.source.indexOf(node.tag) + node.tag.length,
							});
							scriptGen.addText(`;\n`);
						}
						if (!node.isSelfClosing && !htmlToTemplate) { // end tag
							scriptGen.addText(`__VLS_components`);
							writePropertyAccess(true, getComponentName(node.tag), capabilitiesSet.htmlTagOrAttr, {
								start: node.loc.start.offset + node.loc.source.lastIndexOf(node.tag),
								end: node.loc.start.offset + node.loc.source.lastIndexOf(node.tag) + node.tag.length,
							});
							scriptGen.addText(`;\n`);
						}

						scriptGen.addText(`const `);
						writeCode(false, varName, MapedMode.Gate, capabilitiesSet.diagnosticOnly, {
							start: node.loc.start.offset + node.loc.source.indexOf(node.tag),
							end: node.loc.start.offset + node.loc.source.indexOf(node.tag) + node.tag.length,
						});
						scriptGen.addText(`: typeof __VLS_componentProps['${getComponentName(node.tag)}'] = {\n`);
					}
					else {
						scriptGen.addText(`// @ts-ignore\n`);
						scriptGen.addText(`__VLS_componentProps['${getComponentName(node.tag)}'] = {\n`);
					}
				}
				function addEndWrap() {
					if (!forDuplicateClassOrStyleAttr) {
						scriptGen.addText(`}; ${varName};\n`);
					}
					else {
						scriptGen.addText(`};\n`);
					}
				}
			}
			function writeClassScopeds(node: ElementNode) {
				for (const prop of node.props) {
					if (
						prop.type === NodeTypes.ATTRIBUTE
						&& prop.name === 'class'
						&& prop.value
					) {
						let startOffset = prop.value.loc.start.offset + 1; // +1 is "
						let tempClassName = '';

						for (const char of (prop.value.content + ' ')) {
							if (char.trim() !== '') {
								tempClassName += char;
							}
							else {
								addClass(tempClassName, startOffset);
								startOffset += tempClassName.length + 1;
								tempClassName = '';
							}
						}

						function addClass(className: string, offset: number) {
							scriptGen.addText(`// @ts-ignore\n`);
							scriptGen.addText(`__VLS_styleScopedClasses`);
							writePropertyAccess(
								false,
								className,
								{ ...capabilitiesSet.className, displayWithLink: cssScopedClassesSet.has(className) },
								{ start: offset, end: offset + className.length }
							);
							scriptGen.addText(`;\n`);
						}
					}
				}
			}
			function writeOns(node: ElementNode) {
				// @ts-ignore
				const context: TransformContext = {
					onError: () => { },
					helperString: str => str.toString(),
					cacheHandlers: false,
					prefixIdentifiers: false,
				};

				for (const prop of node.props) {
					if (
						prop.type === NodeTypes.DIRECTIVE
						&& prop.arg
						&& prop.exp
						&& prop.arg.type === NodeTypes.SIMPLE_EXPRESSION
						&& prop.exp.type === NodeTypes.SIMPLE_EXPRESSION
						&& prop.name === 'on'
					) {
						const var_on = `__VLS_${elementIndex++}`;
						const key_1 = prop.arg.content;
						const key_2 = camelize('on-' + key_1);

						scriptGen.addText(`let ${var_on}!: { '${key_1}': __VLS_FirstFunction<typeof __VLS_componentProps['${getComponentName(node.tag)}'][`);
						writeCodeWithQuotes(false, key_2, capabilitiesSet.htmlTagOrAttr, {
							start: prop.arg.loc.start.offset,
							end: prop.arg.loc.end.offset,
						});
						scriptGen.addText(`], __VLS_PickEmitFunction<typeof __VLS_componentEmits['${getComponentName(node.tag)}'], '${key_1}'>> };\n`);

						const transformResult = transformOn(prop, node, context);
						for (const prop_2 of transformResult.props) {
							const value = prop_2.value;
							scriptGen.addText(`${var_on} = {\n`);
							writeObjectProperty(false, key_1, capabilitiesSet.htmlTagOrAttr, {
								start: prop.arg.loc.start.offset,
								end: prop.arg.loc.end.offset,
							});
							scriptGen.addText(`: `);

							if (value.type === NodeTypes.SIMPLE_EXPRESSION) {
								writeCode(false, value.content, MapedMode.Offset, capabilitiesSet.all, {
									start: value.loc.start.offset,
									end: value.loc.end.offset,
								}, true, ['', '']);
							}
							else if (value.type === NodeTypes.COMPOUND_EXPRESSION) {
								for (const child of value.children) {
									if (typeof child === 'string') {
										scriptGen.addText(child);
									}
									else if (typeof child === 'symbol') {
										// ignore
									}
									else if (child.type === NodeTypes.SIMPLE_EXPRESSION) {
										if (child.content === prop.exp.content) {
											writeCode(false, child.content, MapedMode.Offset, capabilitiesSet.all, {
												start: child.loc.start.offset,
												end: child.loc.end.offset,
											}, true, ['', '']);
										}
										else {
											scriptGen.addText(child.content);
										}
									}
								}
							}
							scriptGen.addText(`\n};\n`);
						}
					}
				}
			}
			function writeSlots(node: ElementNode) {
				if (node.tag !== 'slot') return;
				const varDefaultBind = `__VLS_${elementIndex++}`;
				const varBinds = `__VLS_${elementIndex++}`;
				const varSlot = `__VLS_${elementIndex++}`;
				const slotName = getSlotName();
				let hasDefaultBind = false;

				for (const prop of node.props) {
					if (
						prop.type === NodeTypes.DIRECTIVE
						&& !prop.arg
						&& prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION
					) {
						hasDefaultBind = true;
						scriptGen.addText(`const ${varDefaultBind} = (`);
						writeCode(false, prop.exp.content, MapedMode.Offset, capabilitiesSet.all, {
							start: prop.exp.loc.start.offset,
							end: prop.exp.loc.end.offset,
						}, true, ['(', ')']);
						scriptGen.addText(`);\n`);
						break;
					}
				}

				scriptGen.addText(`const ${varBinds} = {\n`);
				for (const prop of node.props) {
					if (
						prop.type === NodeTypes.DIRECTIVE
						&& prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION
						&& prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION
					) {
						writeObjectProperty(true, prop.arg.content, capabilitiesSet.htmlTagOrAttr, {
							start: prop.arg.loc.start.offset,
							end: prop.arg.loc.end.offset,
						});
						scriptGen.addText(`: (`);
						writeCode(false, prop.exp.content, MapedMode.Offset, capabilitiesSet.all, {
							start: prop.exp.loc.start.offset,
							end: prop.exp.loc.end.offset,
						}, true, ['(', ')']);
						scriptGen.addText(`),\n`);
					}
					else if (
						prop.type === NodeTypes.ATTRIBUTE
						&& prop.name !== 'name' // slot name
					) {
						const propValue = prop.value !== undefined ? `\`${prop.value.content.replace(/`/g, '\\`')}\`` : 'true';
						writeObjectProperty(true, prop.name, capabilitiesSet.htmlTagOrAttr, {
							start: prop.loc.start.offset,
							end: prop.loc.start.offset + prop.name.length
						});
						scriptGen.addText(`: (`);
						scriptGen.addText(propValue);
						scriptGen.addText(`),\n`);
					}
				}
				scriptGen.addText(`};\n`);

				if (hasDefaultBind) {
					scriptGen.addText(`var ${varSlot}!: typeof ${varDefaultBind} & typeof ${varBinds};\n`);
				}
				else {
					scriptGen.addText(`var ${varSlot}!: typeof ${varBinds};\n`);
				}

				slots.set(slotName, {
					varName: varSlot,
					loc: {
						start: node.loc.start.offset + node.loc.source.indexOf(node.tag),
						end: node.loc.start.offset + node.loc.source.indexOf(node.tag) + node.tag.length,
					},
				});

				function getSlotName() {
					for (const prop2 of node.props) {
						if (prop2.name === 'name' && prop2.type === NodeTypes.ATTRIBUTE && prop2.value) {
							if (prop2.value.content === '') {
								return 'default';
							}
							else {
								return prop2.value.content;
							}
						}
					}
					return 'default';
				}
			}
		}
		else if (node.type === NodeTypes.TEXT_CALL) {
			// {{ var }}
			writeNode(node.content, parents.concat(node));
		}
		else if (node.type === NodeTypes.COMPOUND_EXPRESSION) {
			// {{ ... }} {{ ... }}
			for (const childNode of node.children) {
				if (typeof childNode === 'object') {
					writeNode(childNode as TemplateChildNode, parents.concat(node));
				}
			}
		}
		else if (node.type === NodeTypes.INTERPOLATION) {
			// {{ ... }}
			const context = node.loc.source.substring(2, node.loc.source.length - 2);
			let start = node.loc.start.offset + 2;

			scriptGen.addText(`{`);
			writeCode(false, context, MapedMode.Offset, capabilitiesSet.all, {
				start: start,
				end: start + context.length,
			}, true, ['{', '}']);
			scriptGen.addText(`};\n`);
		}
		else if (node.type === NodeTypes.IF) {
			// v-if / v-else-if / v-else
			let firstIf = true;

			for (const branch of node.branches) {
				if (branch.condition) {
					if (branch.condition.type === NodeTypes.SIMPLE_EXPRESSION) {

						const context = branch.condition.content;
						let start = branch.condition.loc.start.offset;

						if (firstIf) {
							firstIf = false;
							scriptGen.addText(`if (\n`);
							scriptGen.addText(`(`);
							writeCode(false, context, MapedMode.Offset, capabilitiesSet.all, {
								start: start,
								end: start + context.length,
							}, true, ['(', ')']);
							scriptGen.addText(`)\n`);
							scriptGen.addText(`) {\n`);
						}
						else {
							scriptGen.addText(`else if (\n`);
							scriptGen.addText(`(`);
							writeCode(false, context, MapedMode.Offset, capabilitiesSet.all, {
								start: start,
								end: start + context.length,
							}, true, ['(', ')']);
							scriptGen.addText(`)\n`);
							scriptGen.addText(`) {\n`);
						}
						for (const childNode of branch.children) {
							writeNode(childNode, parents.concat([node, branch]));
						}
						scriptGen.addText('}\n');
					}
				}
				else {
					scriptGen.addText('else {\n');
					for (const childNode of branch.children) {
						writeNode(childNode, parents.concat([node, branch]));
					}
					scriptGen.addText('}\n');
				}
			}
		}
		else if (node.type === NodeTypes.FOR) {
			// v-for
			const source = node.parseResult.source;
			const value = node.parseResult.value;
			const key = node.parseResult.key;
			const index = node.parseResult.index;

			if (value
				&& source.type === NodeTypes.SIMPLE_EXPRESSION
				&& value.type === NodeTypes.SIMPLE_EXPRESSION) {

				let start_value = value.loc.start.offset;
				let start_source = source.loc.start.offset;

				const sourceVarName = `__VLS_${elementIndex++}`;
				// const __VLS_100 = 123;
				// const __VLS_100 = vmValue;
				scriptGen.addText(`const ${sourceVarName} = __VLS_getVforSourceType(`);
				writeCode(false, source.content, MapedMode.Offset, capabilitiesSet.noFormatting, {
					start: start_source,
					end: start_source + source.content.length,
				});
				scriptGen.addText(`);\n`);
				scriptGen.addText(`for (__VLS_for_key in `);
				writeCode(false, sourceVarName, MapedMode.Gate, capabilitiesSet.diagnosticOnly, {
					start: source.loc.start.offset,
					end: source.loc.end.offset,
				});
				scriptGen.addText(`) {\n`);

				scriptGen.addText(`const `);
				writeCode(false, value.content, MapedMode.Offset, capabilitiesSet.noFormatting, {
					start: start_value,
					end: start_value + value.content.length,
				});
				scriptGen.addText(` = ${sourceVarName}[__VLS_for_key];\n`);

				if (key && key.type === NodeTypes.SIMPLE_EXPRESSION) {
					let start_key = key.loc.start.offset;
					scriptGen.addText(`const `);
					writeCode(false, key.content, MapedMode.Offset, capabilitiesSet.noFormatting, {
						start: start_key,
						end: start_key + key.content.length,
					});
					scriptGen.addText(` = __VLS_getVforKeyType(${sourceVarName});\n`);
				}
				if (index && index.type === NodeTypes.SIMPLE_EXPRESSION) {
					let start_index = index.loc.start.offset;
					scriptGen.addText(`const `);
					writeCode(false, index.content, MapedMode.Offset, capabilitiesSet.noFormatting, {
						start: start_index,
						end: start_index + index.content.length,
					});
					scriptGen.addText(` = __VLS_getVforIndexType(${sourceVarName});\n`);
				}
				for (const childNode of node.children) {
					writeNode(childNode, parents.concat(node));
				}
				scriptGen.addText('}\n');
			}
		}
		else if (node.type === NodeTypes.TEXT) {
			// not needed progress
		}
		else if (node.type === NodeTypes.COMMENT) {
			// not needed progress
		}
		else {
			scriptGen.addText(`// Unprocessed node type: ${node.type} json: ${JSON.stringify(node.loc)}\n`);
		}
	};
	function writeObjectProperty(patchRename: boolean, mapCode: string, capabilities: TsMappingData['capabilities'], sourceRange: { start: number, end: number }) {
		if (/^[a-zA-Z_$][0-9a-zA-Z_$]*$/.test(mapCode)) {
			return writeCode(patchRename, mapCode, MapedMode.Offset, capabilities, sourceRange);
		}
		else {
			return writeCodeWithQuotes(patchRename, mapCode, capabilities, sourceRange);
		}
	}
	function writePropertyAccess(patchRename: boolean, mapCode: string, capabilities: TsMappingData['capabilities'], sourceRange: { start: number, end: number }, addCode = true) {
		if (/^[a-zA-Z_$][0-9a-zA-Z_$]*$/.test(mapCode)) {
			if (addCode) scriptGen.addText(`.`);
			return writeCode(patchRename, mapCode, MapedMode.Offset, capabilities, sourceRange, addCode);
		}
		else {
			if (addCode) scriptGen.addText(`[`);
			const result = writeCodeWithQuotes(patchRename, mapCode, capabilities, sourceRange, addCode);
			if (addCode) scriptGen.addText(`]`);
			return result;
		}
	}
	function writeCodeWithQuotes(patchRename: boolean, mapCode: string, capabilities: TsMappingData['capabilities'], sourceRange: { start: number, end: number }, addCode = true) {
		writeCode(patchRename, `'${mapCode}'`, MapedMode.Gate, {
			...capabilities,
			rename: false,
			formatting: false,
			completion: false,
			semanticTokens: false,
			referencesCodeLens: false,
		}, sourceRange, false);
		if (addCode) scriptGen.addText(`'`);
		const result = writeCode(patchRename, mapCode, MapedMode.Offset, capabilities, sourceRange, addCode, undefined);
		if (addCode) scriptGen.addText(`'`);
		return result;
	}
	// function mapping(mapCode: string, sourceRange: { start: number, end: number }, mode: MapedMode, data: TsMappingData, addCode = true, formatWrapper?: [string, string]) {
	function writeCode(patchRename: boolean, mapCode: string, mode: MapedMode, capabilities: TsMappingData['capabilities'], sourceRange: { start: number, end: number }, addCode = true, formatWrapper?: [string, string]) {
		if (htmlToTemplate) {
			const newStart = htmlToTemplate(sourceRange.start, sourceRange.end);
			if (newStart !== undefined) {
				const offset = newStart - sourceRange.start;
				sourceRange = {
					start: sourceRange.start + offset,
					end: sourceRange.end + offset,
				};
			}
			else {
				// not found
				return;
			}
		}
		if (formatWrapper) {
			formatGen.addText(formatWrapper[0]);
			formatGen.addCode(
				mapCode,
				sourceRange,
				mode,
				{
					vueTag: 'template',
					capabilities: {
						formatting: true,
					},
				},
			);
			formatGen.addText(formatWrapper[1]);
			formatGen.addText(`\n;\n`);
		}
		const result = scriptGen.addMapping(
			mapCode,
			sourceRange,
			mode,
			{
				doRename: patchRename ? keepHyphenateName : undefined,
				vueTag: 'template',
				capabilities: capabilities,
			},
		);
		if (addCode) {
			scriptGen.addText(mapCode);
		}
		return result;
	}
};
function keepHyphenateName(oldName: string, newName: string) {
	if (oldName === hyphenate(oldName)) {
		return hyphenate(newName);
	}
	return newName
}
