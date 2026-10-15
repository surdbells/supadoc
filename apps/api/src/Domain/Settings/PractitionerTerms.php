<?php

declare(strict_types=1);

namespace App\Domain\Settings;

use RuntimeException;

/**
 * The practitioner terms every doctor must accept before clinical work, and
 * re-accept when they change. The version in force is DOCTOR_TERMS_VERSION
 * (default "1.0"); its text is resources/terms/practitioner-terms-v{version}.md
 * (a whole-number version may drop its ".0": v1.md for 1.0). A doctor whose
 * accepted version differs from the one in force may sign in but not do new
 * clinical work ({@see \App\Domain\Doctor\DoctorStanding}).
 *
 * The text is served as plain blocks (headings, paragraphs, list items) so the
 * portals render it without injecting HTML.
 */
final class PractitionerTerms
{
    public const DEFAULT_VERSION = '1.0';

    private static ?string $version = null;

    private static ?string $dir = null;

    /** Set the version in force (and, for tests, where the texts live). */
    public static function configure(string $version, ?string $dir = null): void
    {
        self::$version = self::clean($version);
        if ($dir !== null) {
            self::$dir = rtrim($dir, '/\\');
        }
    }

    /** The version in force: configured, else DOCTOR_TERMS_VERSION, else 1.0. */
    public static function version(): string
    {
        return self::$version ??= self::clean((string) ($_ENV['DOCTOR_TERMS_VERSION'] ?? ''));
    }

    /**
     * The terms in force: version, title, the text as blocks and as markdown,
     * and the text's sha256 (recorded with each acceptance).
     *
     * @return array{version:string, title:string, blocks:list<array{type:string, text:string}>, markdown:string, sha256:string}
     * @throws RuntimeException when the text for the version in force is missing
     */
    public static function document(): array
    {
        $version  = self::version();
        $markdown = self::text($version);
        $blocks   = self::blocks($markdown);
        $title    = 'VideoMed practitioner terms';
        foreach ($blocks as $block) {
            if ($block['type'] === 'h1') {
                $title = $block['text'];
                break;
            }
        }

        return [
            'version'  => $version,
            'title'    => $title,
            'blocks'   => $blocks,
            'markdown' => $markdown,
            'sha256'   => hash('sha256', $markdown),
        ];
    }

    /**
     * Why an acceptance (`{version, agree}`) can't be recorded, as field =>
     * message: the doctor must accept the version in force (a page left open
     * across an update gets the new one first) and tick the box.
     *
     * @return array<string,string>
     */
    public static function acceptanceProblems(array $body): array
    {
        $problems = [];
        $version  = trim((string) ($body['version'] ?? ''));
        if ($version !== self::version()) {
            $problems['version'] = 'The practitioner terms have been updated. Read version ' . self::version() . ' and accept it.';
        }
        if (!in_array($body['agree'] ?? null, [true, 1, '1', 'true'], true)) {
            $problems['agree'] = 'Tick the box to confirm you accept the practitioner terms';
        }

        return $problems;
    }

    /**
     * Split the markdown into blocks: h1–h3 headings, paragraphs (consecutive
     * lines joined), and `ul` / `ol` list items one block each. Inline markup
     * (`**bold**`, `_em_`) is stripped — the portals show plain text.
     *
     * @return list<array{type:string, text:string}>
     */
    public static function blocks(string $markdown): array
    {
        $blocks    = [];
        $paragraph = [];
        $flush     = static function () use (&$paragraph, &$blocks): void {
            if ($paragraph !== []) {
                $blocks[]  = ['type' => 'p', 'text' => self::plain(implode(' ', $paragraph))];
                $paragraph = [];
            }
        };

        foreach (preg_split('/\R/', $markdown) ?: [] as $line) {
            $trimmed = trim($line);
            if ($trimmed === '') {
                $flush();
                continue;
            }
            if (preg_match('/^(#{1,3})\s+(.+)$/', $trimmed, $m) === 1) {
                $flush();
                $blocks[] = ['type' => 'h' . strlen($m[1]), 'text' => self::plain($m[2])];
                continue;
            }
            if (preg_match('/^[-*]\s+(.+)$/', $trimmed, $m) === 1) {
                $flush();
                $blocks[] = ['type' => 'ul', 'text' => self::plain($m[1])];
                continue;
            }
            if (preg_match('/^(\d+)[.)]\s+(.+)$/', $trimmed, $m) === 1) {
                $flush();
                $blocks[] = ['type' => 'ol', 'text' => self::plain($m[2])];
                continue;
            }
            $paragraph[] = $trimmed;
        }
        $flush();

        return $blocks;
    }

    private static function text(string $version): string
    {
        $dir        = self::$dir ?? dirname(__DIR__, 3) . '/resources/terms';
        $candidates = [$dir . '/practitioner-terms-v' . $version . '.md'];
        if (preg_match('/^(\d+)\.0$/', $version, $m) === 1) {
            $candidates[] = $dir . '/practitioner-terms-v' . $m[1] . '.md';
        }
        foreach ($candidates as $path) {
            if (is_file($path)) {
                return trim((string) file_get_contents($path));
            }
        }

        throw new RuntimeException(sprintf(
            'Practitioner terms v%s are missing: add resources/terms/practitioner-terms-v%s.md or set DOCTOR_TERMS_VERSION to a version that exists.',
            $version,
            $version,
        ));
    }

    private static function clean(string $version): string
    {
        $version = trim($version);

        return preg_match('/^\d{1,4}(\.\d{1,4}){0,2}$/', $version) === 1 ? $version : self::DEFAULT_VERSION;
    }

    private static function plain(string $text): string
    {
        return trim(preg_replace(['/\*\*(.+?)\*\*/', '/(?<![A-Za-z0-9])_(.+?)_(?![A-Za-z0-9])/', '/`([^`]+)`/'], ['$1', '$1', '$1'], $text) ?? $text);
    }
}
