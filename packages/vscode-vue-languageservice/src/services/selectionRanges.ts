import type { TsApiRegisterOptions } from '../types';
import {
	Position,
	SelectionRange,
} from 'vscode-languageserver/node';
import { SourceFile } from '../sourceFiles';
import * as globalServices from '../globalServices';
import type { TextDocument } from 'vscode-languageserver-textdocument';

export function register({ sourceFiles, tsLanguageService }: TsApiRegisterOptions) {
	return (document: TextDocument, positions: Position[]) => {
		const sourceFile = sourceFiles.get(document.uri);
		if (!sourceFile) return;
		const ranges = positions.map(pos => ({ start: pos, end: pos }));

		const tsResult = getTsResult(sourceFile);
		const htmlResult = getHtmlResult(sourceFile);
		const cssResult = getCssResult(sourceFile);
		return [...cssResult, ...htmlResult, ...tsResult];

		function getTsResult(sourceFile: SourceFile) {
			let result: SelectionRange[] = [];
			for (const range of ranges) {
				for (const sourceMap of sourceFile.getTsSourceMaps()) {
					for (const tsLoc of sourceMap.sourceToTargets(range)) {
						if (!tsLoc.data.capabilities.basic) continue;
						const selectRange = tsLanguageService.getSelectionRange(sourceMap.targetDocument.uri, tsLoc.range.start);
						if (selectRange) {
							const vueLoc = sourceMap.targetToSource(selectRange.range);
							if (vueLoc) {
								result.push({
									range: vueLoc.range,
									// TODO: parent
								});
							}
						}
					}
				}
			}
			return result;
		}
		function getHtmlResult(sourceFile: SourceFile) {
			let result: SelectionRange[] = [];
			for (const range of ranges) {
				for (const sourceMap of sourceFile.getHtmlSourceMaps()) {
					for (const htmlLoc of sourceMap.sourceToTargets(range)) {
						const selectRanges = globalServices.html.getSelectionRanges(sourceMap.targetDocument, [htmlLoc.range.start]);
						for (const selectRange of selectRanges) {
							const vueLoc = sourceMap.targetToSource(selectRange.range);
							if (vueLoc) {
								result.push({
									range: vueLoc.range,
									// TODO: parent
								});
							}
						}
					}
				}
			}
			return result;
		}
		function getCssResult(sourceFile: SourceFile) {
			let result: SelectionRange[] = [];
			for (const range of ranges) {
				for (const sourceMap of sourceFile.getCssSourceMaps()) {
					const cssLanguageService = globalServices.getCssService(sourceMap.targetDocument.languageId);
					if (!cssLanguageService) continue;
					for (const cssLoc of sourceMap.sourceToTargets(range)) {
						const selectRanges = cssLanguageService.getSelectionRanges(sourceMap.targetDocument, [cssLoc.range.start], sourceMap.stylesheet);
						for (const selectRange of selectRanges) {
							const vueLoc = sourceMap.targetToSource(selectRange.range);
							if (vueLoc) {
								result.push({
									range: vueLoc.range,
									// TODO: parent
								});
							}
						}
					}
				}
			}
			return result;
		}
	}
}
