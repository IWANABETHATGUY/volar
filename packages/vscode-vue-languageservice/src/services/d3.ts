import type { TsApiRegisterOptions } from '../types';
import {
	Range,
	Location,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import * as references from './references';
import * as definitions from './definitions';
import type * as ts from 'typescript';
import { getTypescript } from '@volar/vscode-builtin-packages';

export function register({ sourceFiles, tsLanguageService }: TsApiRegisterOptions) {

	const ts = getTypescript();
	const findReferences = references.register(arguments[0]);
	const findDefinition = definitions.register(arguments[0]);

	return async (document: TextDocument) => {

		const usedNames = new Set<string>();
		const usedNamesMap = new Map<number, string>();
		const refs: {
			type: 'ref',
			name: string,
			range: Range,
			blockRange: Range,
			references: Location[], // refCalls
		}[] = [];
		const funcs: {
			type: 'func',
			name: string,
			range: Range,
			blockRange: Range,
		}[] = [];
		const funcCalls: {
			name: string,
			range: Range,
			definitions: Location[],
		}[] = [];

		const sourceFile = sourceFiles.get(document.uri);
		const tsDoc = tsLanguageService.getTextDocument(document.uri);

		if (sourceFile) {

			const template = sourceFile.getDescriptor().template;
			if (template) {
				funcs.push({
					type: 'func',
					name: '__template__',
					range: {
						start: document.positionAt(template.loc.start),
						end: document.positionAt(template.loc.start),
					},
					blockRange: {
						start: document.positionAt(template.loc.start),
						end: document.positionAt(template.loc.end),
					},
				});
			}

			for (const sourceMap of sourceFile.getTsSourceMaps()) {
				const virtualCode = sourceMap.targetDocument.getText();
				const scriptAst = ts.createSourceFile('', virtualCode, ts.ScriptTarget.Latest);

				nodeWalker(scriptAst);

				function nodeWalker(node: ts.Node) {
					if (
						ts.isVariableDeclaration(node)
						&& ts.isIdentifier(node.name)
						&& node.initializer
						&& ts.isCallExpression(node.initializer)
						&& isRef(node.initializer, scriptAst)
					) {
						const loc = sourceMap.targetToSource({
							start: sourceMap.targetDocument.positionAt(node.name.getStart(scriptAst)),
							end: sourceMap.targetDocument.positionAt(node.name.getStart(scriptAst) + node.name.getWidth(scriptAst)),
						});
						const _argRange = getArgRanges(node.initializer, scriptAst);
						const argsStartLoc = _argRange ? sourceMap.targetToSource({
							start: sourceMap.targetDocument.positionAt(_argRange.start),
							end: sourceMap.targetDocument.positionAt(_argRange.start),
						}) : undefined;
						const argsEndLoc = _argRange ? sourceMap.targetToSource({
							start: sourceMap.targetDocument.positionAt(_argRange.end),
							end: sourceMap.targetDocument.positionAt(_argRange.end),
						}) : undefined;
						if (loc && argsStartLoc && argsEndLoc) {
							refs.push({
								type: 'ref',
								name: getNodeName(loc.range),
								range: loc.range,
								blockRange: {
									start: argsStartLoc.range.start,
									end: argsEndLoc.range.start,
								},
								references: findReferences(sourceMap.sourceDocument, loc.range.start),
							});
						}
						for (const arg of node.initializer.arguments) {
							arg.forEachChild(child => nodeWalker(child));
						}
					}
					else if (
						ts.isFunctionDeclaration(node)
						&& node.name
						&& node.body
					) {
						const loc = sourceMap.targetToSource({
							start: sourceMap.targetDocument.positionAt(node.name.getStart(scriptAst)),
							end: sourceMap.targetDocument.positionAt(node.name.getStart(scriptAst) + node.name.getWidth(scriptAst)),
						});
						const blockStartLoc = sourceMap.targetToSource({
							start: sourceMap.targetDocument.positionAt(node.body.getStart(scriptAst)),
							end: sourceMap.targetDocument.positionAt(node.body.getStart(scriptAst)),
						});
						const blockEndLoc = sourceMap.targetToSource({
							start: sourceMap.targetDocument.positionAt(node.body.getStart(scriptAst) + node.body.getWidth(scriptAst)),
							end: sourceMap.targetDocument.positionAt(node.body.getStart(scriptAst) + node.body.getWidth(scriptAst)),
						});
						if (loc && blockStartLoc && blockEndLoc) {
							funcs.push({
								type: 'func',
								name: getNodeName(loc.range),
								range: loc.range,
								blockRange: {
									start: blockStartLoc.range.start,
									end: blockEndLoc.range.start,
								},
							});
						}
						node.forEachChild(child => nodeWalker(child));
					}
					else if (
						ts.isVariableDeclaration(node)
						&& node.name
						&& node.initializer
						&& ts.isIdentifier(node.name)
						&& ts.isArrowFunction(node.initializer)
					) {
						const nameLoc = sourceMap.targetToSource({
							start: sourceMap.targetDocument.positionAt(node.name.getStart(scriptAst)),
							end: sourceMap.targetDocument.positionAt(node.name.getStart(scriptAst) + node.name.getWidth(scriptAst)),
						});
						const startLoc = sourceMap.targetToSource({
							start: sourceMap.targetDocument.positionAt(node.initializer.getStart(scriptAst)),
							end: sourceMap.targetDocument.positionAt(node.initializer.getStart(scriptAst)),
						});
						const endLoc = sourceMap.targetToSource({
							start: sourceMap.targetDocument.positionAt(node.initializer.getStart(scriptAst) + node.initializer.getWidth(scriptAst)),
							end: sourceMap.targetDocument.positionAt(node.initializer.getStart(scriptAst) + node.initializer.getWidth(scriptAst)),
						});
						const blockStartLoc = sourceMap.targetToSource({
							start: sourceMap.targetDocument.positionAt(node.initializer.body.getStart(scriptAst)),
							end: sourceMap.targetDocument.positionAt(node.initializer.body.getStart(scriptAst)),
						});
						const blockEndLoc = sourceMap.targetToSource({
							start: sourceMap.targetDocument.positionAt(node.initializer.body.getStart(scriptAst) + node.initializer.body.getWidth(scriptAst)),
							end: sourceMap.targetDocument.positionAt(node.initializer.body.getStart(scriptAst) + node.initializer.body.getWidth(scriptAst)),
						});
						if (nameLoc && startLoc && endLoc && blockStartLoc && blockEndLoc) {
							funcs.push({
								type: 'func',
								name: getNodeName(nameLoc.range),
								range: {
									start: startLoc.range.start,
									end: endLoc.range.start,
								},
								blockRange: {
									start: blockStartLoc.range.start,
									end: blockEndLoc.range.start,
								},
							});
						}
						node.forEachChild(child => nodeWalker(child));
					}
					else if (ts.isCallExpression(node)) {
						const name = getCallName(node);
						if (name) {
							const loc = sourceMap.targetToSource({
								start: sourceMap.targetDocument.positionAt(name.getStart(scriptAst)),
								end: sourceMap.targetDocument.positionAt(name.getStart(scriptAst) + name.getWidth(scriptAst)),
							});
							const _argRange = getArgRanges(node, scriptAst);
							const argsLoc = _argRange ? sourceMap.targetToSource({
								start: sourceMap.targetDocument.positionAt(_argRange.start),
								end: sourceMap.targetDocument.positionAt(_argRange.end),
							}) : undefined;
							if (loc && argsLoc) {
								funcCalls.push({
									name: sourceMap.sourceDocument.getText(loc.range),
									range: loc.range,
									definitions: findDefinition(sourceMap.sourceDocument, loc.range.start),
								});
							}
						}
						node.forEachChild(child => nodeWalker(child));
					}
					else {
						node.forEachChild(child => nodeWalker(child));
					}
				}
			}
		}
		else if (tsDoc) {
			// TODO: extract to function
			const virtualCode = tsDoc.getText();
			const scriptAst = ts.createSourceFile('', virtualCode, ts.ScriptTarget.Latest);

			nodeWalker(scriptAst, tsDoc);

			function nodeWalker(node: ts.Node, tsDoc: TextDocument) {
				if (
					ts.isVariableDeclaration(node)
					&& ts.isIdentifier(node.name)
					&& node.initializer
					&& ts.isCallExpression(node.initializer)
					&& isRef(node.initializer, scriptAst)
				) {
					const loc = {
						start: tsDoc.positionAt(node.name.getStart(scriptAst)),
						end: tsDoc.positionAt(node.name.getStart(scriptAst) + node.name.getWidth(scriptAst)),
					};
					const _argRange = getArgRanges(node.initializer, scriptAst);
					const argsStartLoc = _argRange ? {
						start: tsDoc.positionAt(_argRange.start),
						end: tsDoc.positionAt(_argRange.start),
					} : undefined;
					const argsEndLoc = _argRange ? {
						start: tsDoc.positionAt(_argRange.end),
						end: tsDoc.positionAt(_argRange.end),
					} : undefined;
					if (loc && argsStartLoc && argsEndLoc) {
						refs.push({
							type: 'ref',
							name: _getNodeName(tsDoc.getText(loc)),
							range: loc,
							blockRange: {
								start: argsStartLoc.start,
								end: argsEndLoc.start,
							},
							references: findReferences(tsDoc, loc.start),
						});
					}
					for (const arg of node.initializer.arguments) {
						arg.forEachChild(child => nodeWalker(child, tsDoc));
					}
				}
				else if (
					ts.isFunctionDeclaration(node)
					&& node.name
					&& node.body
				) {
					const loc = {
						start: tsDoc.positionAt(node.name.getStart(scriptAst)),
						end: tsDoc.positionAt(node.name.getStart(scriptAst) + node.name.getWidth(scriptAst)),
					};
					const blockStartLoc = {
						start: tsDoc.positionAt(node.body.getStart(scriptAst)),
						end: tsDoc.positionAt(node.body.getStart(scriptAst)),
					};
					const blockEndLoc = {
						start: tsDoc.positionAt(node.body.getStart(scriptAst) + node.body.getWidth(scriptAst)),
						end: tsDoc.positionAt(node.body.getStart(scriptAst) + node.body.getWidth(scriptAst)),
					};
					if (loc && blockStartLoc && blockEndLoc) {
						funcs.push({
							type: 'func',
							name: _getNodeName(tsDoc.getText(loc)),
							range: loc,
							blockRange: {
								start: blockStartLoc.start,
								end: blockEndLoc.start,
							},
						});
					}
					node.forEachChild(child => nodeWalker(child, tsDoc));
				}
				else if (
					ts.isVariableDeclaration(node)
					&& node.name
					&& node.initializer
					&& ts.isIdentifier(node.name)
					&& ts.isArrowFunction(node.initializer)
				) {
					const startLoc = {
						start: tsDoc.positionAt(node.initializer.getStart(scriptAst)),
						end: tsDoc.positionAt(node.initializer.getStart(scriptAst)),
					};
					const endLoc = {
						start: tsDoc.positionAt(node.initializer.getStart(scriptAst) + node.initializer.getWidth(scriptAst)),
						end: tsDoc.positionAt(node.initializer.getStart(scriptAst) + node.initializer.getWidth(scriptAst)),
					};
					const blockStartLoc = {
						start: tsDoc.positionAt(node.initializer.body.getStart(scriptAst)),
						end: tsDoc.positionAt(node.initializer.body.getStart(scriptAst)),
					};
					const blockEndLoc = {
						start: tsDoc.positionAt(node.initializer.body.getStart(scriptAst) + node.initializer.body.getWidth(scriptAst)),
						end: tsDoc.positionAt(node.initializer.body.getStart(scriptAst) + node.initializer.body.getWidth(scriptAst)),
					};
					if (startLoc && endLoc && blockStartLoc && blockEndLoc) {
						funcs.push({
							type: 'func',
							name: _getNodeName(node.name.getText(scriptAst)),
							range: {
								start: startLoc.start,
								end: endLoc.start,
							},
							blockRange: {
								start: blockStartLoc.start,
								end: blockEndLoc.start,
							},
						});
					}
					node.forEachChild(child => nodeWalker(child, tsDoc));
				}
				else if (ts.isCallExpression(node)) {
					const name = getCallName(node);
					if (name) {
						const loc = {
							start: tsDoc.positionAt(name.getStart(scriptAst)),
							end: tsDoc.positionAt(name.getStart(scriptAst) + name.getWidth(scriptAst)),
						};
						const _argRange = getArgRanges(node, scriptAst);
						const argsLoc = _argRange ? {
							start: tsDoc.positionAt(_argRange.start),
							end: tsDoc.positionAt(_argRange.end),
						} : undefined;
						if (loc && argsLoc) {
							funcCalls.push({
								name: tsDoc.getText(loc),
								range: loc,
								definitions: findDefinition(tsDoc, loc.start),
							});
						}
					}
					node.forEachChild(child => nodeWalker(child, tsDoc));
				}
				else {
					node.forEachChild(child => nodeWalker(child, tsDoc));
				}
			}
		}

		const refsLinks = new Map<string, Set<string>>();
		const funcsLinks = new Map<string, Set<string>>();
		const fileLinks = new Map<string, Set<string>>();

		for (const ref of refs) {
			refsLinks.set(ref.name, new Set());
		}
		for (const func of funcs) {
			funcsLinks.set(func.name, new Set());
		}
		for (const ref of refs) {
			for (const reference of ref.references) {
				if (reference.uri === document.uri) {
					const match = findBestMatchBlock(reference.range);
					if (match) {
						if (match.type === 'ref') {
							refsLinks.get(match.name)?.add(ref.name);
						}
						else if (match.type === 'func') {
							funcsLinks.get(match.name)?.add(ref.name);
						}
					}
				}
				else {
					// TODO
					// const fileName = upath.basename(reference.uri).replace(/\./g, '_');
					const fileName = '__out_of_file__';
					if (!fileLinks.has(fileName)) {
						fileLinks.set(fileName, new Set());
					}
					fileLinks.get(fileName)?.add(ref.name);
				}
			}
		}
		for (const funcCall of funcCalls) {
			for (const definition of funcCall.definitions) {
				if (definition.uri === document.uri) {
					const definitionFunc = funcs.find(func =>
						definition.range.start.line === func.range.start.line
						&& definition.range.start.character === func.range.start.character
						&& definition.range.end.line === func.range.end.line
						&& definition.range.end.character === func.range.end.character
					);
					const match = findBestMatchBlock(funcCall.range);
					if (definitionFunc && match) {
						if (match.type === 'ref') {
							refsLinks.get(match.name)?.add(definitionFunc.name);
						}
						else if (match.type === 'func') {
							funcsLinks.get(match.name)?.add(definitionFunc.name);
						}
					}
				}
				else {
					// TODO
					// const fileName = upath.basename(definition.uri).replace(/\./g, '_');
					const fileName = '__out_of_file__';
					const match = findBestMatchBlock(funcCall.range);
					if (match) {
						if (match.type === 'ref') {
							refsLinks.get(match.name)?.add(fileName);
						}
						else if (match.type === 'func') {
							funcsLinks.get(match.name)?.add(fileName);
						}
					}
				}
			}
		}
		let outStr = `digraph  {`;
		for (const [source, targets] of refsLinks) {
			outStr += `    ${source} [shape="box"]`;
			for (const target of targets) {
				outStr += `    ${source} -> ${target}`;
			}
		}
		for (const [source, targets] of funcsLinks) {
			for (const target of targets) {
				outStr += `    ${source} -> ${target}`;
			}
		}
		for (const [source, targets] of fileLinks) {
			for (const target of targets) {
				outStr += `    ${source} -> ${target}`;
			}
		}
		outStr += `}`;
		return outStr;

		function getCallName(call: ts.CallExpression) {
			if (ts.isIdentifier(call.expression)) {
				return call.expression
			}
			else if (ts.isPropertyAccessExpression(call.expression)) {
				return call.expression.name
			}
		}
		function isRef(call: ts.CallExpression, scriptAst: ts.SourceFile) {
			const name = getCallName(call);
			if (!name) return false;
			return name.getText(scriptAst) === 'ref' || name.getText(scriptAst) === 'computed' || name.getText(scriptAst) === 'reactive'; // TODO
		}
		function getArgRanges(call: ts.CallExpression, scriptAst: ts.SourceFile) {
			if (!call.arguments.length) return;
			const startArg = call.arguments[0];
			const endArg = call.arguments[call.arguments.length - 1];
			return {
				start: startArg.getStart(scriptAst),
				end: endArg.getStart(scriptAst) + endArg.getWidth(scriptAst),
			};
		}
		function _getNodeName(name: string) {
			if (!usedNames.has(name)) {
				usedNames.add(name);
				return name;
			}
			let i = 1;
			let newName = `${name}_${i}`;
			while (usedNames.has(newName)) {
				i++;
				newName = `${name}_${i}`;
			}
			usedNames.add(newName);
			return newName;
		}
		function getNodeName(range: Range) {
			const offset = document.offsetAt(range.start);
			if (usedNamesMap.has(offset)) {
				return usedNamesMap.get(offset)!;
			}
			const name = _getNodeName(document.getText(range));
			usedNamesMap.set(offset, name);
			return name;
		}
		function findBestMatchBlock(range: Range) {
			const _refs = refs.filter(ref =>
				document.offsetAt(range.start) >= document.offsetAt(ref.blockRange.start)
				&& document.offsetAt(range.end) <= document.offsetAt(ref.blockRange.end)
			);
			const _funcs = funcs.filter(func =>
				document.offsetAt(range.start) >= document.offsetAt(func.blockRange.start)
				&& document.offsetAt(range.end) <= document.offsetAt(func.blockRange.end)
			);
			const _arr = [..._refs, ..._funcs];
			if (!_arr.length) return;
			return _arr.sort((a, b) =>
				(document.offsetAt(a.blockRange.end) - document.offsetAt(a.blockRange.start))
				- (document.offsetAt(b.blockRange.end) - document.offsetAt(b.blockRange.start))
			)[0];
		}
	}
}
