import type { TsApiRegisterOptions } from '../types';
import type { Position } from 'vscode-languageserver/node';
import type { Location } from 'vscode-languageserver/node';
import type { SourceFile } from '../sourceFiles';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import * as dedupe from '../utils/dedupe';
import { tsLocationToVueLocations } from '../utils/commons';
import { findSourceFileByTsUri } from '../utils/commons';
import { TsMappingData } from '../utils/sourceMaps';
import { getCssService } from '../globalServices';

export function register({ sourceFiles, tsLanguageService, getGlobalTsSourceMaps }: TsApiRegisterOptions) {
	return (document: TextDocument, position: Position) => {

		const sourceFile = sourceFiles.get(document.uri);

		if (!sourceFile) {
			let result = onTs(document, position);
			result = result.filter(loc => sourceFiles.has(loc.uri)); // dedupe typescript-language-features
			return dedupe.withLocations(result);
		}

		return dedupe.withLocations([
			...onVueTs(sourceFile, position),
			...onVueCss(sourceFile, position),
		]);
	}
	// vue locs -> ts locs
	function onVueTs(sourceFile: SourceFile, position: Position) {
		let result: Location[] = [];
		for (const sourceMap of sourceFile.getTsSourceMaps()) {
			for (const tsLoc of sourceMap.sourceToTargets({ start: position, end: position })) {
				if (!tsLoc.data.capabilities.references) continue;
				result = result.concat(onTs(sourceMap.targetDocument, tsLoc.range.start, tsLoc.data.vueTag));
			}
		}
		return result;
	}
	// ts loc -> find references -> vue locs
	function onTs(tsDoc: TextDocument, tsPos: Position, from: TsMappingData['vueTag'] = 'script') {
		const tsLocs: Location[] = [];
		worker(tsDoc, tsPos, from);
		return tsLocs.map(tsLoc => tsLocationToVueLocations(tsLoc, sourceFiles, getGlobalTsSourceMaps?.())).flat();

		function worker(doc: TextDocument, pos: Position, from: TsMappingData['vueTag']) {
			const references = tsLanguageService.findReferences(doc.uri, pos);
			for (const reference of references) {

				if (hasLocation(reference)) continue;
				tsLocs.push(reference);

				const sourceFile_2 = findSourceFileByTsUri(sourceFiles, reference.uri);
				if (!sourceFile_2) continue;

				const teleports = sourceFile_2.getTeleports();
				for (const teleport of teleports) {
					if (teleport.document.uri === reference.uri) {
						for (const loc of teleport.findTeleports(reference.range, from)) {
							if (!loc.data.capabilities.references) continue;
							if (!hasLocation({ uri: reference.uri, range: loc.range })) {
								worker(teleport.document, loc.range.start, from);
							}
						}
					}
				}
			}
		}
		// TODO: use map
		function hasLocation(loc: Location) {
			return tsLocs.find(tsLoc =>
				tsLoc.uri === loc.uri
				&& tsLoc.range.start.line === loc.range.start.line
				&& tsLoc.range.start.character === loc.range.start.character
				&& tsLoc.range.end.line === loc.range.end.line
				&& tsLoc.range.end.character === loc.range.end.character
			)
		}
	}
	// vue locs -> css locs -> find refernces -> vue locs
	function onVueCss(sourceFile: SourceFile, position: Position) {
		let result: Location[] = [];
		for (const sourceMap of sourceFile.getCssSourceMaps()) {
			const cssLs = getCssService(sourceMap.targetDocument.languageId);
			if (!cssLs) continue;
			for (const cssMaped of sourceMap.sourceToTargets({ start: position, end: position })) {
				const cssRefs = cssLs.findReferences(sourceMap.targetDocument, cssMaped.range.start, sourceMap.stylesheet);
				if (!cssRefs) continue;
				for (const cssRef of cssRefs) {
					const vueRef = sourceMap.targetToSource(cssRef.range);
					if (vueRef) {
						result.push({
							uri: sourceMap.sourceDocument.uri,
							range: vueRef.range,
						});
					}
				}
			}
		}
		return result;
	}
}
