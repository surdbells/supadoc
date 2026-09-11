<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Document\DocumentType;
use App\Domain\Entity\MedicalDocument;
use PHPUnit\Framework\TestCase;

final class MedicalDocumentTest extends TestCase
{
    public function testCatalogueIsUsableAndValidates(): void
    {
        $all = DocumentType::all();
        self::assertNotEmpty($all);
        self::assertSame(['value', 'label'], array_keys($all[0]));

        self::assertTrue(DocumentType::isValid('laboratory_test_report'));
        self::assertTrue(DocumentType::isValid('other'));
        self::assertFalse(DocumentType::isValid('nonsense'));
        self::assertSame('X-Ray Report', DocumentType::label('xray_report'));
        self::assertSame('Document', DocumentType::label('nonsense'));
    }

    public function testSizeLabelFormatsBytes(): void
    {
        self::assertSame('5MB', $this->doc(5 * 1024 * 1024)->sizeLabel());
        self::assertSame('2.5MB', $this->doc((int) (2.5 * 1024 * 1024))->sizeLabel());
        self::assertSame('512KB', $this->doc(512 * 1024)->sizeLabel());
        self::assertSame('900B', $this->doc(900)->sizeLabel());
    }

    public function testTypeLabelUsesCustomForOther(): void
    {
        $known = new MedicalDocument('p1', MedicalDocument::UPLOADER_PATIENT, 'Ada', 'blood_test_report', 'CBC', 's.png', 'image/png', 'png', 100);
        self::assertSame('Blood Test Report', $known->typeLabel());

        $other = new MedicalDocument('p1', MedicalDocument::UPLOADER_PATIENT, 'Ada', 'other', 'Thing', 's.pdf', 'application/pdf', 'pdf', 100);
        $other->setCustomType('Travel vaccination card');
        self::assertSame('Travel vaccination card', $other->typeLabel());

        $other->initTimestamps(); // Doctrine fires this on persist; toArray() reads createdAt.
        $arr = $other->toArray();
        self::assertSame('other', $arr['document_type']);
        self::assertSame('Travel vaccination card', $arr['type_label']);
    }

    private function doc(int $bytes): MedicalDocument
    {
        return new MedicalDocument('p1', MedicalDocument::UPLOADER_PATIENT, 'Ada', 'laboratory_test_report', 'Report', 'stored.png', 'image/png', 'png', $bytes);
    }
}
