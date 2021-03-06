import { TextDocument } from 'vscode-languageserver-textdocument';
import { computed, Ref } from '@vue/reactivity';
import { IDescriptor } from '../types';
import * as SourceMaps from '../utils/sourceMaps';
import * as languageServices from '../utils/languageServices';
import * as json from 'vscode-json-languageservice';

export function useJsonsRaw(
	getUnreactiveDoc: () => TextDocument,
	customBlocks: Ref<IDescriptor['customBlocks']>,
) {
	let version = 0;
	const textDocuments = computed(() => {
		const vueDoc = getUnreactiveDoc();
		const documents: {
			index: number,
			textDocument: TextDocument,
			jsonDocument: json.JSONDocument,
		}[] = [];
		for (let i = 0; i < customBlocks.value.length; i++) {
			const customBlock = customBlocks.value[i];
			const lang = customBlock.lang;
			const content = customBlock.content;
			const uri = vueDoc.uri + '.' + i + '.' + lang;
			const document = TextDocument.create(uri, lang, version++, content);
			if (lang === 'json' || lang === 'jsonc') {
				documents.push({
					index: i,
					textDocument: document,
					jsonDocument: languageServices.json.parseJSONDocument(document),
				});
			}
		}
		return documents;
	});
	const sourceMaps = computed(() => {
		const vueDoc = getUnreactiveDoc();
		const sourceMaps: SourceMaps.JsonSourceMap[] = [];
		for (const doc of textDocuments.value) {
			const customBlock = customBlocks.value[doc.index];
			const sourceMap = new SourceMaps.JsonSourceMap(
				vueDoc,
				doc.textDocument,
				doc.jsonDocument,
			);
			sourceMap.add({
				data: undefined,
				mode: SourceMaps.Mode.Offset,
				sourceRange: {
					start: customBlock.loc.start,
					end: customBlock.loc.end,
				},
				mappedRange: {
					start: 0,
					end: customBlock.loc.end - customBlock.loc.start,
				},
			});
			sourceMaps.push(sourceMap);
		}
		return sourceMaps;
	});
	return {
		textDocuments,
		sourceMaps,
	};
}
