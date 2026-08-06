<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Exception\EntityNotFoundException;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\EntityRepository;
use Doctrine\ORM\QueryBuilder;
use Doctrine\ORM\Tools\Pagination\Paginator;

/**
 * Hand-written base. Concrete repos are registered in the container and extend
 * this — deliberately NOT wired as Doctrine custom repository classes, which
 * would recurse through getRepository() (see ARCHITECTURE §6).
 */
abstract class BaseRepository
{
    public function __construct(protected readonly EntityManagerInterface $em)
    {
    }

    /** @return class-string */
    abstract protected function getEntityClass(): string;

    protected function getRepo(): EntityRepository
    {
        return new EntityRepository(
            $this->em,
            $this->em->getClassMetadata($this->getEntityClass()),
        );
    }

    public function find(string $id): ?object
    {
        return $this->getRepo()->find($id);
    }

    public function findOrFail(string $id): object
    {
        $entity = $this->find($id);
        if ($entity === null) {
            throw EntityNotFoundException::for($this->getEntityClass(), $id);
        }

        return $entity;
    }

    public function persist(object $entity): void
    {
        $this->em->persist($entity);
    }

    public function remove(object $entity): void
    {
        $this->em->remove($entity);
    }

    public function flush(): void
    {
        $this->em->flush();
    }

    public function save(object $entity): void
    {
        $this->persist($entity);
        $this->flush();
    }

    protected function alias(): string
    {
        return 'e';
    }

    protected function qb(): QueryBuilder
    {
        return $this->em->createQueryBuilder()
            ->select($this->alias())
            ->from($this->getEntityClass(), $this->alias());
    }

    /**
     * Runs a query builder with LIMIT/OFFSET + ordering and returns items + total.
     * `$sortBy` is a DQL field (camelCase) — the ApiResponse pagination helper
     * has already converted it from snake_case.
     *
     * @return array{items: list<object>, total: int}
     */
    protected function paginatedQuery(
        QueryBuilder $qb,
        string $alias,
        int $offset,
        int $perPage,
        string $sortBy = 'createdAt',
        string $sortDir = 'desc',
    ): array {
        $qb->orderBy("$alias.$sortBy", strtoupper($sortDir) === 'ASC' ? 'ASC' : 'DESC')
            ->setFirstResult(max(0, $offset))
            ->setMaxResults(max(1, $perPage));

        $paginator = new Paginator($qb, fetchJoinCollection: false);

        return [
            'items' => iterator_to_array($paginator),
            'total' => count($paginator),
        ];
    }
}
