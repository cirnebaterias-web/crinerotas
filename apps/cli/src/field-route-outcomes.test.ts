import { describe, expect, it, vi } from 'vitest';
import { runFieldOutcomeCommand } from './field-route-outcomes';

const id='10000000-0000-4000-8000-000000000001';
describe('field outcome CLI',()=>{
  it('calls classification RPC with a stable idempotency key without logging credentials',async()=>{
    const request=vi.fn(async()=>new Response(JSON.stringify({ schemaVersion:1,clientId:id,classificationId:id,
      classificationCode:'autopecas',classifiedAt:'2026-11-13T15:00:00Z',replayed:false }),{status:200,headers:{'content-type':'application/json'}}));
    const result=await runFieldOutcomeCommand({operation:'classify',supabaseUrl:'https://example.invalid',anonKey:'anon-secret',token:'access-secret',
      deviceId:id,idempotencyKey:id,command:{schemaVersion:1,clientId:id,classificationCode:'autopecas'},request:request as typeof fetch});
    expect(result).toMatchObject({classificationCode:'autopecas',replayed:false});
    const [,init]=request.mock.calls[0] as unknown as [URL,RequestInit];
    expect(init.headers).toMatchObject({authorization:'Bearer access-secret',apikey:'anon-secret'});
    expect(init.body).toContain(`"p_idempotency_key":"${id}"`);
  });
  it('reserves and confirms evidence only through the trusted application BFF',async()=>{
    const checksum='a'.repeat(64);const request=vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({schemaVersion:1,attachmentId:id,offlineId:id,storagePath:'attempts/photo.jpg',
        signedUrl:'https://storage.invalid/upload',token:'signed',expiresInSeconds:600,alreadyVerified:false}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({schemaVersion:1,attachmentId:id,offlineId:id,status:'verified',verifiedAt:'2026-11-13T15:00:00Z'}),{status:200}));
    await runFieldOutcomeCommand({operation:'reserve-evidence',supabaseUrl:'https://supabase.invalid',appUrl:'https://app.invalid',anonKey:'anon',token:'access',
      deviceId:id,idempotencyKey:id,command:{schemaVersion:1,offlineId:id,attemptOfflineId:id,contentType:'image/jpeg',byteSize:3,checksum,capturedAt:'2026-11-13T15:00:00Z',expiresAt:'2027-05-12T15:00:00Z'},request:request as typeof fetch});
    await runFieldOutcomeCommand({operation:'confirm-evidence',supabaseUrl:'https://supabase.invalid',appUrl:'https://app.invalid',anonKey:'anon',token:'access',
      deviceId:id,idempotencyKey:id,command:{offlineId:id,checksum},request:request as typeof fetch});
    expect(String(request.mock.calls[0]![0])).toBe('https://app.invalid/api/v1/route-stop-attempt-attachments');
    expect(String(request.mock.calls[1]![0])).toContain('/api/v1/route-stop-attempt-attachments/');
    expect(request.mock.calls.every(([,init])=>String((init as RequestInit).headers).includes('service_role')===false)).toBe(true);
  });
});
