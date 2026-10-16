<?php

declare(strict_types=1);

namespace App\Infrastructure\Storage;

/** An uploaded photo broke a rule; the message is the reason to show the user. */
final class PhotoRejectedException extends \RuntimeException
{
}
