-- Private Supabase Storage bucket for product photos. Objects are stored at
-- <store_id>/<image_id>.jpg and are never overwritten (a new photo gets a
-- new id), so only read and insert are allowed.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy staff_read_product_images on storage.objects for select to authenticated
  using (bucket_id = 'product-images' and (storage.foldername(name))[1] = public.my_store()::text);

create policy photo_editors_upload_product_images on storage.objects for insert to authenticated
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = public.my_store()::text
    and exists (
      select 1 from public.staff_profiles p
      where p.user_id = auth.uid() and p.active and (p.role in ('owner', 'manager') or p.can_edit_photos)
    )
  );
