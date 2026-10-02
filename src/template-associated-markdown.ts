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
