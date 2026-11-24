export function selectAssociatedMarkdownFile<T extends { path: string }>(
    candidates: T[],
    preferredFiles: (T | null | undefined)[],
) {
    const uniqueCandidates = [...new Map(candidates.map((file) => [file.path, file])).values()];
    for (const preferredFile of preferredFiles) {
        if (!preferredFile) continue;
        const match = uniqueCandidates.find((candidate) => candidate.path === preferredFile.path);
        if (match) return match;
    }
    return uniqueCandidates.sort((a, b) => a.path.localeCompare(b.path))[0] ?? null;
}

export interface CitationMetadataSource<TFile, TProperties> {
    file: TFile | null;
    properties: TProperties;
    pointsToPdf?: boolean;
}

export function selectCitationMetadataSources<TFile extends { path: string }, TProperties>(
    associatedFile: TFile | null,
    associatedProperties: TProperties,
    candidates: CitationMetadataSource<TFile, TProperties>[],
) {
    const selected: CitationMetadataSource<TFile, TProperties>[] = [];
    const selectedPaths = new Set<string>();
    const add = (source: CitationMetadataSource<TFile, TProperties>) => {
        if (!source.file || selectedPaths.has(source.file.path)) return;
        selected.push(source);
        selectedPaths.add(source.file.path);
    };

    add({ file: associatedFile, properties: associatedProperties, pointsToPdf: true });
    for (const candidate of candidates) {
        if (candidate.pointsToPdf) add(candidate);
    }
    return selected;
}
