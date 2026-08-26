<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

/**
 * Clinical copilot — turns a consultation transcript into a STRUCTURED DRAFT
 * (summary + SOAP + extracted symptoms/medications/diagnoses) via an LLM. The
 * output is always a draft for the clinician to review, edit and approve; it never
 * becomes the record on its own (that stays with the clinician via the note flow).
 *
 * Uses the Anthropic Messages API. Unconfigured (no API key) => isConfigured() is
 * false and callers return 503. Model + base URL are env-overridable.
 */
final class CopilotService
{
    private const VERSION = '2023-06-01';

    public function __construct(
        private readonly string $apiKey,
        private readonly string $model,
        private readonly string $baseUrl,
    ) {
    }

    public function isConfigured(): bool
    {
        return $this->apiKey !== '';
    }

    /**
     * @return array{summary:string,subjective:string,objective:string,assessment:string,plan:string,symptoms:list<string>,medications:list<string>,diagnoses:list<string>,follow_up:string}
     */
    public function draft(string $transcript): array
    {
        if (!$this->isConfigured()) {
            throw new \RuntimeException('AI copilot is not configured');
        }
        if (trim($transcript) === '') {
            throw new \RuntimeException('There is no transcript to summarise yet');
        }

        $system = <<<'SYS'
            You are a clinical documentation assistant. From the consultation transcript,
            produce a STRUCTURED DRAFT to help the clinician document the visit. This is a
            draft for the clinician to review and edit — never a final record and never a
            definitive diagnosis. Base everything ONLY on the transcript; do not invent
            findings, vitals or history. If something is not present, use an empty string
            or an empty array.

            Respond with ONLY a JSON object (no markdown, no commentary) with exactly these
            keys: "summary" (string), "subjective" (string), "objective" (string),
            "assessment" (string), "plan" (string), "symptoms" (array of strings),
            "medications" (array of strings), "diagnoses" (array of strings),
            "follow_up" (string).
            SYS;

        $raw = $this->request([
            'model'      => $this->model,
            'max_tokens' => 1500,
            'system'     => $system,
            'messages'   => [[
                'role'    => 'user',
                'content' => "Consultation transcript:\n\n" . $transcript,
            ]],
        ]);

        $text = '';
        foreach ((array) ($raw['content'] ?? []) as $block) {
            if (is_array($block) && ($block['type'] ?? '') === 'text' && is_string($block['text'] ?? null)) {
                $text .= $block['text'];
            }
        }

        return $this->parse($text);
    }

    /** @return array<string,mixed> */
    private function parse(string $text): array
    {
        // Strip any accidental markdown fences before decoding.
        $clean = trim($text);
        $clean = (string) preg_replace('/^```(?:json)?\s*|\s*```$/m', '', $clean);
        $start = strpos($clean, '{');
        $end   = strrpos($clean, '}');
        if ($start !== false && $end !== false && $end > $start) {
            $clean = substr($clean, $start, $end - $start + 1);
        }

        $json = json_decode($clean, true);
        if (!is_array($json)) {
            throw new \RuntimeException('The copilot returned an unreadable draft');
        }

        $str  = static fn (string $k): string => is_string($json[$k] ?? null) ? trim($json[$k]) : '';
        $list = static function (string $k) use ($json): array {
            $v = $json[$k] ?? [];

            return is_array($v) ? array_values(array_filter(array_map(
                static fn ($x): string => is_string($x) ? trim($x) : '',
                $v,
            ), static fn (string $s): bool => $s !== '')) : [];
        };

        return [
            'summary'     => $str('summary'),
            'subjective'  => $str('subjective'),
            'objective'   => $str('objective'),
            'assessment'  => $str('assessment'),
            'plan'        => $str('plan'),
            'symptoms'    => $list('symptoms'),
            'medications' => $list('medications'),
            'diagnoses'   => $list('diagnoses'),
            'follow_up'   => $str('follow_up'),
        ];
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    private function request(array $body): array
    {
        $ch = curl_init(rtrim($this->baseUrl, '/') . '/v1/messages');
        if ($ch === false) {
            throw new \RuntimeException('Copilot service unreachable');
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_HTTPHEADER     => [
                'Content-Type: application/json',
                'x-api-key: ' . $this->apiKey,
                'anthropic-version: ' . self::VERSION,
            ],
            CURLOPT_POSTFIELDS     => json_encode($body),
            CURLOPT_TIMEOUT        => 45,
            CURLOPT_CONNECTTIMEOUT => 8,
        ]);
        $raw    = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if (!is_string($raw)) {
            throw new \RuntimeException('Copilot service unreachable');
        }
        $json = json_decode($raw, true);
        if (!is_array($json)) {
            throw new \RuntimeException('Unexpected copilot response');
        }
        if ($status >= 400) {
            $msg = is_array($json['error'] ?? null) && is_string($json['error']['message'] ?? null)
                ? $json['error']['message']
                : 'request failed';
            throw new \RuntimeException('Copilot error: ' . $msg);
        }

        return $json;
    }
}
