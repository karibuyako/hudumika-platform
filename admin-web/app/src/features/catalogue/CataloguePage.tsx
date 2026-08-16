import { useEffect, useState, type FormEvent } from 'react'
import {
  createCategory,
  deleteCategory,
  listCategories,
  listServiceCategories,
  updateCategory,
  type ProductCategory,
  type ServiceCategoryConfig,
} from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { DetailDrawer } from '../../components/DetailDrawer'
import { ErrorState } from '../../components/ErrorState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'

type TabKey = 'categories' | 'serviceCategories'

interface CategoryForm {
  name: string
  active: boolean
}

const SERVICE_COLUMNS: DataTableColumn<ServiceCategoryConfig>[] = [
  { key: 'name', header: 'Name', render: (sc) => sc.name, sortValue: (sc) => sc.name },
  { key: 'pricing', header: 'Pricing model', render: (sc) => <span className="tag">{sc.pricingModel}</span> },
  {
    key: 'skills',
    header: 'Required skills',
    render: (sc) => {
      const skills = sc.requiredSkills ?? []
      return skills.length === 0 ? (
        '—'
      ) : (
        skills.slice(0, 4).map((s) => (
          <span key={s} className="tag">
            {s}
          </span>
        ))
      )
    },
  },
  {
    key: 'certifications',
    header: 'Required certifications',
    render: (sc) => {
      const certifications = sc.requiredCertifications ?? []
      return certifications.length === 0
        ? '—'
        : certifications.map((c) => (
            <span key={c} className="tag">
              {c}
            </span>
          ))
    },
  },
]

export function CataloguePage() {
  const [tab, setTab] = useState<TabKey>('categories')

  const [categories, setCategories] = useState<ProductCategory[] | null>(null)
  const [categoriesError, setCategoriesError] = useState<string | null>(null)
  const [categoriesRetryKey, setCategoriesRetryKey] = useState(0)

  const [serviceCategories, setServiceCategories] = useState<ServiceCategoryConfig[] | null>(null)
  const [serviceCategoriesError, setServiceCategoriesError] = useState<string | null>(null)
  const [serviceCategoriesRetryKey, setServiceCategoriesRetryKey] = useState(0)

  const [categoryModal, setCategoryModal] = useState<{ category: ProductCategory | null } | null>(null)
  const [categoryError, setCategoryError] = useState<string | null>(null)
  const [categoryBusy, setCategoryBusy] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<ProductCategory | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const [selectedService, setSelectedService] = useState<ServiceCategoryConfig | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const categoryColumns: DataTableColumn<ProductCategory>[] = [
    { key: 'name', header: 'Name', render: (c) => c.name, sortValue: (c) => c.name },
    { key: 'id', header: 'ID', render: (c) => c.id, className: 'mono' },
    { key: 'description', header: 'Description', render: () => <span className="muted">—</span> },
    {
      key: 'active',
      header: 'Active',
      render: (c) => (
        <StatusPill
          status={c.active ? 'active' : 'inactive'}
          tone={c.active ? 'ok' : 'muted'}
          label={c.active ? 'Active' : 'Inactive'}
        />
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (c) => (
        <>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setToast(null)
              setCategoryError(null)
              setCategoryModal({ category: c })
            }}
          >
            Edit
          </button>{' '}
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              setToast(null)
              setDeleteError(null)
              setDeleteTarget(c)
            }}
          >
            Delete
          </button>
        </>
      ),
    },
  ]

  useEffect(() => {
    setCategoriesError(null)
    listCategories().then((res) => {
      if (res.status === 200) setCategories(res.data)
      else setCategoriesError(parseApiError(res, 'Failed to load categories').message)
    })
  }, [categoriesRetryKey])

  useEffect(() => {
    if (tab !== 'serviceCategories') return
    setServiceCategoriesError(null)
    listServiceCategories().then((res) => {
      if (res.status === 200) setServiceCategories(res.data)
      else setServiceCategoriesError(parseApiError(res, 'Failed to load service categories').message)
    })
  }, [tab, serviceCategoriesRetryKey])

  function submitCategory(form: CategoryForm) {
    const editing = categoryModal?.category ?? null
    setCategoryBusy(true)
    setCategoryError(null)
    const payload: ProductCategory = {
      id: editing?.id ?? '',
      name: form.name.trim(),
      sortOrder: editing?.sortOrder ?? 0,
      active: form.active,
    }
    const req = editing ? updateCategory(editing.id, payload) : createCategory(payload)
    req.then((res) => {
      if (res.status === 200 || res.status === 201) {
        setCategories((prev) => {
          const list = prev ?? []
          const idx = list.findIndex((c) => c.id === res.data.id)
          return idx === -1 ? [...list, res.data] : list.map((c) => (c.id === res.data.id ? res.data : c))
        })
        setToast(editing ? 'Category updated' : 'Category created')
        setCategoryModal(null)
        setCategoriesRetryKey((k) => k + 1)
      } else {
        setCategoryError(parseApiError(res, 'Could not save category').message)
      }
      setCategoryBusy(false)
    })
  }

  function confirmDelete(_reason: string) {
    if (!deleteTarget) return
    setDeleteBusy(true)
    setDeleteError(null)
    deleteCategory(deleteTarget.id).then((res) => {
      if (res.status === 204) {
        const removedId = deleteTarget.id
        setCategories((prev) => (prev ?? []).filter((c) => c.id !== removedId))
        setToast('Category deleted')
        setDeleteTarget(null)
        setCategoriesRetryKey((k) => k + 1)
      } else {
        setDeleteError(parseApiError(res, 'Could not delete category').message)
      }
      setDeleteBusy(false)
    })
  }

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Service catalogue</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      <div className="tabs" role="tablist" aria-label="Catalogue sections">
        <button
          role="tab"
          aria-selected={tab === 'categories'}
          className={`tab${tab === 'categories' ? ' active' : ''}`}
          type="button"
          onClick={() => setTab('categories')}
        >
          Categories
        </button>
        <button
          role="tab"
          aria-selected={tab === 'serviceCategories'}
          className={`tab${tab === 'serviceCategories' ? ' active' : ''}`}
          type="button"
          onClick={() => setTab('serviceCategories')}
        >
          Service categories
        </button>
      </div>

      {tab === 'categories' ? (
        categoriesError ? (
          <ErrorState
            title="Failed to load categories"
            message={categoriesError}
            onRetry={() => setCategoriesRetryKey((k) => k + 1)}
          />
        ) : !categories ? (
          <LoadingSkeleton kind="table" />
        ) : (
          <>
            <div className="toolbar">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setToast(null)
                  setCategoryError(null)
                  setCategoryModal({ category: null })
                }}
              >
                New category
              </button>
            </div>
            <DataTable
              rows={categories}
              columns={categoryColumns}
              rowKey={(c) => c.id}
              exportable
              exportFileName="catalogue-categories"
              emptyTitle="No categories"
              ariaLabel="Product categories"
            />
          </>
        )
      ) : serviceCategoriesError ? (
        <ErrorState
          title="Failed to load service categories"
          message={serviceCategoriesError}
          onRetry={() => setServiceCategoriesRetryKey((k) => k + 1)}
        />
      ) : !serviceCategories ? (
        <LoadingSkeleton kind="table" />
      ) : (
        <>
          <DataTable
            rows={serviceCategories}
            columns={SERVICE_COLUMNS}
            rowKey={(sc) => sc.id}
            onRowClick={setSelectedService}
            emptyTitle="No service categories"
            ariaLabel="Service categories"
          />
          <p className="muted small">
            Service definitions configure pricing, skills, and SLA — full service-definition editing ships with the
            configuration milestone.
          </p>
        </>
      )}

      {categoryModal && (
        <CategoryModal
          initial={categoryModal.category}
          busy={categoryBusy}
          error={categoryError}
          onSubmit={submitCategory}
          onClose={() => {
            if (!categoryBusy) setCategoryModal(null)
          }}
        />
      )}

      {deleteTarget && (
        <ReasonPrompt
          title="Delete category"
          description={`Permanently delete "${deleteTarget.name}"?`}
          maxLength={500}
          required
          tone="danger"
          confirmLabel="Delete"
          busy={deleteBusy}
          error={deleteError}
          onSubmit={confirmDelete}
          onClose={() => {
            if (!deleteBusy) setDeleteTarget(null)
          }}
        />
      )}

      {selectedService && (
        <ServiceCategoryDrawer service={selectedService} onClose={() => setSelectedService(null)} />
      )}
    </div>
  )
}

function CategoryModal({
  initial,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  initial: ProductCategory | null
  busy: boolean
  error: string | null
  onSubmit: (form: CategoryForm) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<CategoryForm>({
    name: initial?.name ?? '',
    active: initial?.active ?? true,
  })

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    onSubmit(form)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={initial ? 'Edit category' : 'New category'}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">{initial ? 'Edit category' : 'New category'}</h3>
        <div className="form-grid">
          <Field label="Name">
            <input
              className="field"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              maxLength={80}
            />
          </Field>
        </div>
        <Field label="Active">
          <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
        </Field>
        {error && <InlineError message={error} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : initial ? 'Save changes' : 'Create category'}
          </button>
        </div>
      </form>
    </div>
  )
}

function ServiceCategoryDrawer({
  service,
  onClose,
}: {
  service: ServiceCategoryConfig
  onClose: () => void
}) {
  const skills = service.requiredSkills ?? []
  const certifications = service.requiredCertifications ?? []
  const equipment = service.requiredEquipment ?? []
  const questions = service.questionnaireTemplate ?? []
  return (
    <DetailDrawer title={service.name} onClose={onClose}>
      <div className="detail-section">
        <h3>Service category</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">ID</span>
            <span className="meta-value mono">{service.id}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Name</span>
            <span className="meta-value">{service.name}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Pricing model</span>
            <span className="meta-value">
              <span className="tag">{service.pricingModel}</span>
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Default duration (min)</span>
            <span className="meta-value">{service.defaultDurationMinutes ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Required photos</span>
            <span className="meta-value">{service.requiredPhotos ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Warranty days</span>
            <span className="meta-value">{service.warrantyDays ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Commission (bps)</span>
            <span className="meta-value">{service.commissionBps ?? '—'}</span>
          </div>
        </div>
      </div>
      <div className="detail-section">
        <h3>Skills, equipment &amp; certification</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Required skills</span>
            <span className="meta-value">
              {skills.length === 0 ? (
                '—'
              ) : (
                skills.map((s) => (
                  <span key={s} className="tag">
                    {s}
                  </span>
                ))
              )}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Required certifications</span>
            <span className="meta-value">
              {certifications.length === 0
                ? '—'
                : certifications.map((c) => (
                    <span key={c} className="tag">
                      {c}
                    </span>
                  ))}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Required equipment</span>
            <span className="meta-value">
              {equipment.length === 0
                ? '—'
                : equipment.map((e) => (
                    <span key={e} className="tag">
                      {e}
                    </span>
                  ))}
            </span>
          </div>
        </div>
      </div>
      <div className="detail-section">
        <h3>Policy &amp; questionnaire</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Cancellation rules</span>
            <span className="meta-value">{service.cancellationRules ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Questionnaire</span>
            <span className="meta-value">
              {questions.length === 0 ? (
                '—'
              ) : (
                <span className="small">
                  {questions.length} question{questions.length === 1 ? '' : 's'}
                </span>
              )}
            </span>
          </div>
        </div>
        {questions.length > 0 && (
          <div className="meta-grid">
            {questions.map((q) => (
              <div key={q.key} className="meta-item">
                <span className="meta-label">{q.label}</span>
                <span className="meta-value mono small">{q.type}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </DetailDrawer>
  )
}
