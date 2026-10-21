<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * bin/send-reminders.php, read as tokens: it runs no job before the clock
 * repair (prod-migrate step 13) is recorded, and every job runs inside a try
 * of its own, so one failing job never stops the others.
 */
final class CronScriptTest extends TestCase
{
    /** Each job's first mention: `<Name>::<member>` (a class name or a qualified one). */
    private const JOBS = [
        ['ReminderService', 'class'],
        ['PrescriptionExpiryService', 'class'],
        ['PastAppointmentCloser', 'runWithRetries'],
        ['FollowUpService', 'class'],
        ['CredentialExpiryService', 'class'],
        ['PaymentIntentService', 'sweepWithRetries'],
        ['DocumentAccessSweeper', 'class'],
    ];

    /** @var list<array{0:int|string, 1:string}> significant tokens: [id or char, text] */
    private array $tokens = [];

    protected function setUp(): void
    {
        foreach (token_get_all((string) file_get_contents(__DIR__ . '/../../bin/send-reminders.php')) as $t) {
            if (is_array($t)) {
                if (in_array($t[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) {
                    continue;
                }
                $this->tokens[] = [$t[0], $t[1]];
            } else {
                $this->tokens[] = [$t, $t];
            }
        }
    }

    /** Index of the first `<Name>::<member>` (the name may be qualified), or -1. */
    private function find(string $name, string $member, int $from = 0): int
    {
        $count = count($this->tokens);
        for ($i = $from; $i < $count - 2; $i++) {
            [$id, $text] = $this->tokens[$i];
            $short = in_array($id, [T_STRING, T_NAME_QUALIFIED, T_NAME_FULLY_QUALIFIED], true) ? substr((string) strrchr('\\' . $text, '\\'), 1) : null;
            if ($short === $name && $this->tokens[$i + 1][0] === T_DOUBLE_COLON && strtolower($this->tokens[$i + 2][1]) === strtolower($member)) {
                return $i;
            }
        }

        return -1;
    }

    public function testNoJobRunsBeforeTheClockRepairGuard(): void
    {
        $guard = $this->find('ClockRepair', 'isPending');
        $first = $this->find('ReminderService', 'class');
        $this->assertGreaterThan(-1, $guard, 'ClockRepair::isPending is checked');
        $this->assertGreaterThan(-1, $first);
        $this->assertLessThan($first, $guard, 'the guard comes before the first job');
        foreach (self::JOBS as [$name, $member]) {
            $this->assertGreaterThan($guard, $this->find($name, $member), "{$name} after the guard");
        }

        $exits = 0;
        for ($i = $guard; $i < $first - 3; $i++) {
            if ($this->tokens[$i][0] === T_EXIT && $this->tokens[$i + 1][1] === '(' && $this->tokens[$i + 2][1] === '1' && $this->tokens[$i + 3][1] === ')') {
                ++$exits;
            }
        }
        $this->assertGreaterThanOrEqual(1, $exits, 'it stops (exit 1) when the repair is pending');
    }

    public function testEveryJobRunsInsideATryOfItsOwn(): void
    {
        foreach (self::JOBS as [$name, $member]) {
            $at = $this->find($name, $member);
            $this->assertGreaterThan(-1, $at, "{$name}::{$member}");
            $try = -1;
            for ($i = $at; $i >= 0; $i--) {
                if ($this->tokens[$i][0] === T_TRY) {
                    $try = $i;
                    break;
                }
            }
            $this->assertGreaterThan(-1, $try, "{$name} has a try before it");
            $depth = 0;
            for ($i = $try; $i < $at; $i++) {
                $text  = $this->tokens[$i][1];
                $depth += match (true) {
                    $text === '{' || $this->tokens[$i][0] === T_CURLY_OPEN || $this->tokens[$i][0] === T_DOLLAR_OPEN_CURLY_BRACES => 1,
                    $text === '}' => -1,
                    default       => 0,
                };
            }
            $this->assertGreaterThan(0, $depth, "{$name} sits inside that try");
        }
    }

    public function testAFailedReminderRunStartsTheOtherJobsOnAFreshContainer(): void
    {
        $reminders = $this->find('ReminderService', 'class');
        $catch     = -1;
        for ($i = $reminders; $i < count($this->tokens); $i++) {
            if ($this->tokens[$i][0] === T_CATCH) {
                $catch = $i;
                break;
            }
        }
        $this->assertGreaterThan(-1, $catch);
        // The catch block: from its `{` to the matching `}`.
        $open = $catch;
        while ($this->tokens[$open][1] !== '{') {
            ++$open;
        }
        $depth = 0;
        $body  = '';
        for ($i = $open; $i < count($this->tokens); $i++) {
            $text = $this->tokens[$i][1];
            $depth += $text === '{' ? 1 : ($text === '}' ? -1 : 0);
            $body  .= $text;
            if ($depth === 0) {
                break;
            }
        }
        $this->assertStringContainsString('$container=$build()', $body);
    }
}
