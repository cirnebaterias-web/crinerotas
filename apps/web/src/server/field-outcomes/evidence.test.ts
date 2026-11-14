import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteRequestError } from '../routes/http';

const mocks=vi.hoisted(()=>({rpc:vi.fn(),verifier:{kind:'service'},createVerifier:vi.fn()}));
vi.mock('./service',()=>({fieldOutcomeRpc:mocks.rpc}));
vi.mock('../evidence-verifier',()=>({createEvidenceVerifierClient:mocks.createVerifier}));
vi.mock('@cirne/config/server',()=>({readEvidenceConfig:()=>({EVIDENCE_STORAGE_BUCKET:'evidence'})}));
import { confirmAttemptEvidence, reserveAttemptEvidence } from './evidence';

const id='10000000-0000-4000-8000-000000000001';
const jpeg=new Uint8Array([0xff,0xd8,0xff,0x01]);
const checksum=createHash('sha256').update(jpeg).digest('hex');
function client(download=new Blob([jpeg],{type:'image/jpeg'})){return {storage:{from:vi.fn(()=>({
  createSignedUploadUrl:vi.fn(async()=>({data:{signedUrl:'https://storage.invalid/upload',token:'token'},error:null})),
  download:vi.fn(async()=>({data:download,error:null})),
}))}} as never;}

describe('trusted route attempt evidence BFF',()=>{
  beforeEach(()=>{vi.clearAllMocks();mocks.createVerifier.mockResolvedValue(mocks.verifier);});
  it('reserves storage after the canonical RPC accepts metadata',async()=>{
    mocks.rpc.mockResolvedValue({attachmentId:id,offlineId:id,storagePath:'attempts/a.jpg',status:'reserved'});
    const result=await reserveAttemptEvidence(client(),id,id,{schemaVersion:1,offlineId:id,attemptOfflineId:id,contentType:'image/jpeg',byteSize:4,checksum,capturedAt:'2026-11-13T15:00:00Z',expiresAt:'2027-05-12T15:00:00Z'});
    expect(result.signedUrl).toBe('https://storage.invalid/upload');expect(mocks.rpc).toHaveBeenCalledWith(expect.anything(),'reserve_route_stop_attempt_attachment',expect.anything());
  });
  it('verifies actual object bytes before calling the service-role RPC',async()=>{
    mocks.rpc.mockResolvedValueOnce({storagePath:'attempts/a.jpg',contentType:'image/jpeg',byteSize:4,checksum})
      .mockResolvedValueOnce({schemaVersion:1,attachmentId:id,offlineId:id,status:'verified',verifiedAt:'2026-11-13T15:00:00Z'});
    await confirmAttemptEvidence(client(),id,id,id,id,checksum);
    expect(mocks.createVerifier).toHaveBeenCalledOnce();expect(mocks.rpc.mock.calls[1]![0]).toBe(mocks.verifier);
  });
  it('rejects mismatched bytes without invoking trusted verification',async()=>{
    mocks.rpc.mockResolvedValueOnce({storagePath:'attempts/a.jpg',contentType:'image/jpeg',byteSize:4,checksum:'b'.repeat(64)});
    await expect(confirmAttemptEvidence(client(),id,id,id,id,checksum)).rejects.toBeInstanceOf(RouteRequestError);
    expect(mocks.createVerifier).not.toHaveBeenCalled();
  });
});
