import type { Position } from 'vscode-languageserver/node';
import type { Location } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { SourceFile } from '../sourceFiles';
import type { TsApiRegisterOptions } from '../types';
import type { TsMappingData } from '../utils/sourceMaps';
import { Range } from 'vscode-languageserver/node';
import { findSourceFileByTsUri } from '../utils/commons';
import { tsLocationToVueLocations } from '../utils/commons';
import * as globalServices from '../globalServices';
import * as dedupe from '../utils/dedupe';

export function register({ sourceFiles, tsLanguageService, getGlobalTsSourceMaps }: TsApiRegisterOptions) {

	return {
		on,
		onType,
	};

	function on(document: TextDocument, position: Position) {

		const sourceFile = sourceFiles.get(document.uri);
		if (!sourceFile) {
			return onTs(document, position, 'script', tsLanguageService.findDefinition)
				.filter(loc => sourceFiles.has(loc.uri)); // dedupe
		}

		return dedupe.withLocations([
			...onVueTs(sourceFile, position, tsLanguageService.findDefinition),
			...onVueCss(sourceFile, position),
		]);
	}
	function onType(document: TextDocument, position: Position) {

		const sourceFile = sourceFiles.get(document.uri);
		if (!sourceFile) {
			return onTs(document, position, 'script', tsLanguageService.findTypeDefinition)
				.filter(loc => sourceFiles.has(loc.uri)); // dedupe
		}

		return dedupe.withLocations([
			...onVueTs(sourceFile, position, tsLanguageService.findTypeDefinition),
		]);
	}
	function onVueTs(sourceFile: SourceFile, position: Position, finder: (uri: string, position: Position) => Location[]) {
		let result: Location[] = [];
		for (const sourceMap of sourceFile.getTsSourceMaps()) {
			for (const tsLoc of sourceMap.sourceToTargets({ start: position, end: position })) {
				if (!tsLoc.data.capabilities.definitions) continue;
				result = result.concat(onTs(sourceMap.targetDocument, tsLoc.range.start, tsLoc.data.vueTag, finder));
			}
		}
		return result;
	}
	function onVueCss(sourceFile: SourceFile, position: Position) {
		let result: Location[] = [];
		const sourceMaps = sourceFile.getCssSourceMaps();
		for (const sourceMap of sourceMaps) {
			const cssLanguageService = globalServices.getCssService(sourceMap.targetDocument.languageId);
			if (!cssLanguageService) continue;
			const cssLocs = sourceMap.sourceToTargets(Range.create(position, position));
			for (const virLoc of cssLocs) {
				const definition = cssLanguageService.findDefinition(sourceMap.targetDocument, virLoc.range.start, sourceMap.stylesheet);
				if (definition) {
					const vueLocs = tsLocationToVueLocations(definition, sourceFiles);
					result = result.concat(vueLocs);
				}
			}
		}
		return result;
	}
	function onTs(
		document: TextDocument,
		position: Position,
		from: TsMappingData['vueTag'],
		finder: (uri: string, position: Position) => Location[],
	) {
		const tsLocs: Location[] = [];
		let result: Location[] = [];

		worker(document, position, from);

		return result.map(r => tsLocationToVueLocations(r, sourceFiles, getGlobalTsSourceMaps?.())).flat();

		function worker(doc: TextDocument, pos: Position, from: TsMappingData['vueTag']) {
			const references = finder(doc.uri, pos);
			for (const reference of references) {

				if (hasLocation(reference)) continue;
				tsLocs.push(reference);

				const sourceFile_2 = findSourceFileByTsUri(sourceFiles, reference.uri);
				if (sourceFile_2) {
					const teleports = sourceFile_2.getTeleports();
					for (const teleport of teleports) {
						if (teleport.document.uri === reference.uri) {
							for (const loc of teleport.findTeleports(reference.range, from)) {
								if (!loc.data.capabilities.definitions) continue;
								if (!hasLocation({ uri: reference.uri, range: loc.range })) {
									worker(teleport.document, loc.range.start, from);
								}
							}
						}
					}
				}

				result.push(reference);
			}
		}
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
}
