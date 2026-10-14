<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Patient\UploadMyDocumentAction;
use App\Domain\Document\DocumentType;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Repository\MedicalDocumentRepository;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\MedicalDocumentStorage;
use Doctrine\ORM\Mapping\Column;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

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

    public function testUploadCustomTypeLimitMatchesTheColumn(): void
    {
        $attrs = (new \ReflectionProperty(MedicalDocument::class, 'customType'))->getAttributes(Column::class);
        self::assertCount(1, $attrs);
        self::assertSame(UploadMyDocumentAction::CUSTOM_TYPE_MAX, $attrs[0]->newInstance()->length);
    }

    public function testUploadRejectsAnOverlongCustomTypeWith422(): void
    {
        $res  = $this->upload(['document_type' => 'other', 'custom_type' => str_repeat('a', UploadMyDocumentAction::CUSTOM_TYPE_MAX + 1)]);
        $body = json_decode((string) $res->getBody(), true);
        self::assertSame(422, $res->getStatusCode());
        self::assertSame('Document type name is too long', $body['message']);
        self::assertSame('Use 120 characters or fewer', $body['errors']['custom_type']);
    }

    public function testUploadCustomTypeLimitCountsCharactersNotBytes(): void
    {
        // 120 multi-byte characters (300 bytes) fit VARCHAR(120); surrounding
        // whitespace is trimmed first. The request then stops at the missing file.
        $res  = $this->upload(['document_type' => 'other', 'custom_type' => '  ' . str_repeat('é€', 60) . '  ']);
        $body = json_decode((string) $res->getBody(), true);
        self::assertSame(422, $res->getStatusCode());
        self::assertArrayHasKey('file', $body['errors']);
        self::assertArrayNotHasKey('custom_type', $body['errors']);
    }

    public function testUploadIgnoresCustomTypeLengthForOtherTypes(): void
    {
        // custom_type is only stored for `other`, so a long stray value is ignored.
        $res  = $this->upload(['document_type' => 'blood_test_report', 'custom_type' => str_repeat('a', 500)]);
        $body = json_decode((string) $res->getBody(), true);
        self::assertSame(422, $res->getStatusCode());
        self::assertArrayHasKey('file', $body['errors']);
        self::assertArrayNotHasKey('custom_type', $body['errors']);
    }

    /** Runs the upload action up to its pre-database checks (no file attached). */
    private function upload(array $fields): ResponseInterface
    {
        $make   = static fn (string $class): object => (new \ReflectionClass($class))->newInstanceWithoutConstructor();
        $action = new UploadMyDocumentAction(
            $make(PatientRepository::class),
            $make(MedicalDocumentRepository::class),
            $make(MedicalDocumentStorage::class),
        );
        $request = (new ServerRequestFactory())
            ->createServerRequest('POST', '/api/portal/documents')
            ->withAttribute('customer_id', 'p1')
            ->withParsedBody($fields);

        return $action($request, (new ResponseFactory())->createResponse());
    }

    private function doc(int $bytes): MedicalDocument
    {
        return new MedicalDocument('p1', MedicalDocument::UPLOADER_PATIENT, 'Ada', 'laboratory_test_report', 'Report', 'stored.png', 'image/png', 'png', $bytes);
    }
}
